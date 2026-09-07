/* MaskIshiba - content script
 * ページ中の「前首相」らしき画像を検出してマスク/置換する。
 *
 * 検出方法（ブラウザ内で顔認識モデルを回さずに済む実用的な手法）:
 *   1. img の alt / title / aria-label / src(ファイル名) にキーワード
 *   2. figcaption や周辺の短いテキスト（写真キャプション、リンク文字列）にキーワード
 *   3. CSS background-image の URL にキーワード
 */

const DEFAULTS = {
  enabled: true,
  mode: 'blur',            // blur | black | replace | hide
  blur: 18,
  emoji: '🐈',
  replaceUrl: '',
  peek: false,             // マウスオーバーで一時的に元画像を表示（既定 OFF）
  preMask: true,           // 名前が出てきたら、判定が終わるまで画像を一律ブラー（一瞬見えるのを防ぐ）
  maskText: false,         // 本文中の名前も塗りつぶす
  minSize: 40,             // これより小さい画像は無視（アイコン避け）
  strictness: 'normal',    // strict: 画像の属性/URLのみ / normal: 周辺の文脈も見る / loose: 名前が出るページの画像は全部
  keywords: ['石破', 'イシバ', 'Ishiba'],
  disabledHosts: []
};

let settings = { ...DEFAULTS };
let keywordRe = null;           // 画像判定用（i）
let keywordReGlobal = null;     // 本文の塗りつぶし用（gi）
const masked = new Set();       // マスク済み要素
let checked = new WeakSet();    // 判定済み要素
let tries = new WeakMap();      // 「対象でない」と判定した回数（SPA では本文が後から届く）
const MAX_TRIES = 6;

// 何度か判定して駄目なら以後スキップする（毎回全画像を調べ続けないため）
function giveUp(el) {
  const n = (tries.get(el) || 0) + 1;
  tries.set(el, n);
  return n >= MAX_TRIES;
}
const textSpans = new Set();    // 文字マスク用に作った span

/* ---------- ユーティリティ ---------- */

// キーワードの照合。
//   ラテン文字（Ishiba 等）は前後を単語境界で区切る。単純な部分一致だと
//   "Samurai Shiba" → textContent 連結で "samuraishiba" → "ishiba" に化けて誤爆するため。
//   日本語（石破 等）は語の区切りが無いので従来どおり部分一致にする。
const isLatin = k => !/[^\x00-\x7f]/.test(k);
const escapeRe = k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildKeywordRe(list, flags) {
  const parts = list.map(k => {
    const esc = escapeRe(k.toLowerCase());
    // 前後が英数字なら別語とみなす（"ishiba_2024.jpg" や "Ishiba's" は拾いたいので _ . ' は境界扱い）
    return isLatin(k) ? `(?<![a-z0-9])${esc}(?![a-z0-9])` : esc;
  });
  return parts.length ? new RegExp(parts.join('|'), flags) : null;
}

function matchText(s) {
  if (!s || !keywordRe) return false;
  keywordRe.lastIndex = 0;
  return keywordRe.test(String(s).toLowerCase());
}

function matchUrl(u) {
  if (!u) return false;
  let s = String(u);
  try { s = decodeURIComponent(s); } catch (e) { /* 不正な % はそのまま */ }
  return matchText(s);
}

function replacementImage() {
  if (settings.replaceUrl && /^(https?:|data:)/.test(settings.replaceUrl)) return settings.replaceUrl;
  const emoji = settings.emoji || '🐈';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" fill="#e9e9ec"/>` +
    `<text x="50" y="54" font-size="58" text-anchor="middle" dominant-baseline="central">${
      emoji.replace(/[<>&]/g, '')}</text></svg>`;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* ---------- 検出 ---------- */

const IMG_ATTRS = ['alt', 'title', 'aria-label', 'data-src', 'data-original',
                   'data-lazy-src', 'data-srcset', 'data-caption'];

// SNS の「1投稿」を表す入れ物。Facebook / X などは本文が画像から DOM 上遠く、
// 画像の alt も URL も手がかりにならないので、投稿ブロックごと見る必要がある。
const POST_SELECTOR = 'article,[role="article"],[role="listitem"],[data-testid*="post"],' +
  '[data-ad-preview],[class*="post"],[class*="tweet"],[class*="status"],[class*="entry"],' +
  '[class*="card"],[class*="feed"],li';
const POST_TEXT_LIMIT = 3000;

// ページ全体（タイトル・本文）に名前が出てくるか
let pageMentionsCache = null;
function pageMentions() {
  if (pageMentionsCache !== null) return pageMentionsCache;
  const body = document.body;
  const t = (document.title || '') + ' ' + (body ? (body.innerText || body.textContent || '').slice(0, 200000) : '');
  pageMentionsCache = matchText(t) || matchUrl(location.href);
  return pageMentionsCache;
}

function looksLikeTarget(img) {
  // loose: 名前の出てくる記事なら画像を全部ぼかす
  if (settings.strictness === 'loose' && pageMentions()) return true;

  for (const a of IMG_ATTRS) {
    const v = img.getAttribute(a);
    if (!v) continue;
    if (a.startsWith('data-s') ? matchUrl(v) : matchText(v)) return true;
  }
  if (matchUrl(img.getAttribute('src')) || matchUrl(img.currentSrc) ||
      matchUrl(img.getAttribute('srcset')) || matchUrl(img.getAttribute('poster'))) return true;

  // <picture><source srcset=...>
  const pic = img.parentElement;
  if (pic && pic.tagName === 'PICTURE') {
    for (const s of pic.querySelectorAll('source')) {
      if (matchUrl(s.getAttribute('srcset')) || matchUrl(s.getAttribute('data-srcset'))) return true;
    }
  }

  if (settings.strictness === 'strict') return false;

  // 投稿ブロック単位（Facebook / X など）。本文がそこそこ長くても投稿1件分なら見る。
  const post = img.closest(POST_SELECTOR);
  if (post) {
    if (matchText(post.getAttribute('aria-label'))) return true;
    const t = post.textContent || '';
    if (t.length <= POST_TEXT_LIMIT && matchText(t)) return true;
  }

  // 写真キャプション
  const fig = img.closest('figure');
  if (fig) {
    const cap = fig.querySelector('figcaption');
    if (cap && matchText(cap.textContent)) return true;
  }

  // リンクの href / アンカーテキスト
  const a = img.closest('a');
  if (a && (matchUrl(a.getAttribute('href')) || matchText((a.textContent || '').slice(0, 200)))) return true;

  // 近くの短いテキスト（記事全文にマッチして誤爆しないよう長さで制限）
  let node = img.parentElement;
  for (let i = 0; i < 4 && node && node !== document.body; i++) {
    const t = node.textContent || '';
    if (t.length > 0 && t.length <= 400 && matchText(t)) return true;
    for (const attr of ['class', 'id', 'aria-label', 'title', 'data-title']) {
      if (matchText(node.getAttribute && node.getAttribute(attr))) return true;
    }
    node = node.parentElement;
  }
  return false;
}

function tooSmall(el) {
  const w = el.offsetWidth || el.width || el.naturalWidth || 0;
  const h = el.offsetHeight || el.height || el.naturalHeight || 0;
  if (w === 0 && h === 0) return false;           // まだレイアウト前 → 判定保留せず通す
  return w < settings.minSize && h < settings.minSize;
}

/* ---------- マスク適用 / 解除 ---------- */

function clearMaskStyles(el) {
  el.classList.remove('ishiba-masked', 'ishiba-masked-black', 'ishiba-masked-hidden');
  el.style.removeProperty('--ishiba-blur');
}

function maskImage(el) {
  if (el.dataset.ishibaOrigSrc === undefined) {
    el.dataset.ishibaOrigSrc = el.getAttribute('src') || '';
    el.dataset.ishibaOrigSrcset = el.getAttribute('srcset') || '';
  } else if (el.dataset.ishibaMode === settings.mode && settings.mode !== 'blur') {
    return; // 同じマスクが既に当たっている
  }
  clearMaskStyles(el);
  // 置換モードから戻すときのため src を復元しておく
  if (el.dataset.ishibaReplaced === '1' && settings.mode !== 'replace') {
    restoreSrc(el);
  }

  switch (settings.mode) {
    case 'black':
      el.classList.add('ishiba-masked-black');
      break;
    case 'hide':
      el.classList.add('ishiba-masked-hidden');
      break;
    case 'replace': {
      const url = replacementImage();
      if (el.getAttribute('src') !== url) {
        el.setAttribute('srcset', '');
        el.setAttribute('src', url);
        el.dataset.ishibaReplaced = '1';
      }
      break;
    }
    default:
      el.style.setProperty('--ishiba-blur', settings.blur + 'px');
      el.classList.add('ishiba-masked');
  }
  el.dataset.ishibaMode = settings.mode;
  masked.add(el);
}

function restoreSrc(el) {
  if (el.dataset.ishibaReplaced === '1') {
    const s = el.dataset.ishibaOrigSrc;
    const ss = el.dataset.ishibaOrigSrcset;
    if (s) el.setAttribute('src', s); else el.removeAttribute('src');
    if (ss) el.setAttribute('srcset', ss); else el.removeAttribute('srcset');
    delete el.dataset.ishibaReplaced;
  }
}

function maskBackground(el) {
  if (el.dataset.ishibaOrigBg === undefined) {
    el.dataset.ishibaOrigBg = el.style.backgroundImage || '';
    el.dataset.ishibaOrigBgColor = el.style.backgroundColor || '';
  }
  clearMaskStyles(el);
  el.style.backgroundImage = el.dataset.ishibaOrigBg;
  el.style.backgroundColor = el.dataset.ishibaOrigBgColor;

  switch (settings.mode) {
    case 'black':
      el.style.backgroundImage = 'none';
      el.style.backgroundColor = '#000';
      break;
    case 'hide':
      el.classList.add('ishiba-masked-hidden');
      break;
    case 'replace':
      el.style.backgroundImage = `url("${replacementImage()}")`;
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.backgroundPosition = 'center';
      break;
    default:
      el.style.setProperty('--ishiba-blur', settings.blur + 'px');
      el.classList.add('ishiba-masked');
      el.style.filter = `blur(${settings.blur}px) grayscale(0.4)`;
  }
  el.dataset.ishibaMode = settings.mode;
  masked.add(el);
}

function unmaskAll() {
  for (const el of masked) {
    clearMaskStyles(el);
    restoreSrc(el);
    if (el.dataset.ishibaOrigBg !== undefined) {
      el.style.backgroundImage = el.dataset.ishibaOrigBg;
      el.style.backgroundColor = el.dataset.ishibaOrigBgColor;
      for (const p of ['filter', 'background-size', 'background-repeat', 'background-position']) {
        el.style.removeProperty(p);
      }
      delete el.dataset.ishibaOrigBg;
      delete el.dataset.ishibaOrigBgColor;
    }
    delete el.dataset.ishibaOrigSrc;
    delete el.dataset.ishibaOrigSrcset;
    delete el.dataset.ishibaMode;
    checked.delete(el);
  }
  masked.clear();
  unmaskText();
  document.body && document.body.classList.remove('ishiba-peek');
  report();
}

/* ---------- 本文中の名前のマスク ---------- */

function maskTextNodes(root) {
  if (!settings.maskText || !keywordReGlobal) return;
  const re = keywordReGlobal;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (/^(SCRIPT|STYLE|TEXTAREA|NOSCRIPT|TITLE)$/.test(p.tagName)) return NodeFilter.FILTER_REJECT;
      if (p.isContentEditable || p.classList.contains('ishiba-text-masked')) return NodeFilter.FILTER_REJECT;
      return matchText(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    }
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);

  for (const node of targets) {
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(node.nodeValue)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'ishiba-text-masked';
      span.textContent = m[0];
      frag.appendChild(span);
      textSpans.add(span);
      last = m.index + m[0].length;
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
    node.parentNode && node.parentNode.replaceChild(frag, node);
  }
}

function unmaskText() {
  for (const span of textSpans) {
    if (span.parentNode) span.parentNode.replaceChild(document.createTextNode(span.textContent), span);
  }
  textSpans.clear();
}

/* ---------- スキャン ---------- */

const BG_SELECTOR = '[style*="background"],[class*="thumb"],[class*="photo"],[class*="image"],' +
  '[class*="img"],[class*="hero"],[class*="eyecatch"],[class*="visual"],[class*="picture"]';

function scan(root = document) {
  if (!settings.enabled) return;
  let n = 0;

  const parsing = document.readyState === 'loading';
  const imgs = root.querySelectorAll ? root.querySelectorAll('img, video') : [];
  for (const img of imgs) {
    if (checked.has(img)) continue;
    if (tooSmall(img)) { if (!parsing && giveUp(img)) checked.add(img); continue; }
    if (looksLikeTarget(img)) { checked.add(img); maskImage(img); n++; }
    else if (!parsing && giveUp(img)) checked.add(img);
  }

  let count = 0;
  const bgs = root.querySelectorAll ? root.querySelectorAll(BG_SELECTOR) : [];
  for (const el of bgs) {
    if (++count > 2000) break;
    if (checked.has(el) || masked.has(el)) continue;
    if (!parsing && giveUp(el)) checked.add(el);
    const inline = el.style && el.style.backgroundImage;
    const bg = inline || (el.children.length < 30 ? getComputedStyle(el).backgroundImage : 'none');
    if (!bg || bg === 'none' || !bg.includes('url(')) continue;
    // URL が一致する場合か、テキストを含まない画像枠が周辺文脈と一致する場合のみ
    if (matchUrl(bg) || (!(el.textContent || '').trim() && looksLikeTarget(el))) {
      if (tooSmall(el)) continue;
      maskBackground(el); n++;
    }
  }

  if (settings.maskText) {
    maskTextNodes(root === document ? (document.body || document.documentElement) : root);
  }
  // 判定が済んだので一律ブラーは解除（パース中はまだ画像が増えるので保持）
  if (!parsing && root === document) releasePrescan();
  if (n) report();
}

let reportTimer = null;
function report() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    try {
      chrome.runtime.sendMessage({ type: 'ishiba-count', count: masked.size });
    } catch (e) { /* 拡張がリロードされた直後など */ }
  }, 100);
}

/* ---------- 監視 ----------
 * 「一瞬見えてしまう」対策:
 *   (a) 要素が DOM に挿入された瞬間に同期でマスクする（描画される前に間に合う）
 *   (b) ページに名前が出てきた時点で、判定が終わるまで画像を一律ブラーにする（先読みブラー）
 */

let pending = false;

const observer = new MutationObserver(muts => {
  let mention = false;
  for (const m of muts) {
    if (m.type === 'attributes') {
      if (m.target) { checked.delete(m.target); maskNow(m.target); }
      continue;
    }
    for (const node of m.addedNodes) {
      if (node.nodeType === 3) { mention = mention || matchText(node.data); continue; }
      if (node.nodeType !== 1) continue;
      mention = mention || earlyMention(node);
      maskNow(node);
      if (node.querySelectorAll) {
        for (const el of node.querySelectorAll('img, video')) maskNow(el);
      }
    }
  }
  if (mention) prescan();
  if (!settings.enabled || pending) return;
  pending = true;
  if (typeof requestIdleCallback === 'function') requestIdleCallback(flush, { timeout: 300 });
  else setTimeout(flush, 100);
});

// 挿入直後の要素を即マスクする（周辺テキストは未着かもしれないので checked には入れない）
function maskNow(el) {
  if (!settings.enabled || !el || el.nodeType !== 1) return;
  if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') return;
  if (checked.has(el) || masked.has(el)) return;
  if (tooSmall(el)) return;
  if (looksLikeTarget(el)) { checked.add(el); maskImage(el); report(); }
}

function flush() {
  pending = false;
  const before = pageMentionsCache;
  pageMentionsCache = null;   // DOM が変わったので判定し直す
  // loose モードで「名前が出てきた」瞬間は既存の画像も対象になるので判定をやり直す
  if (settings.strictness === 'loose' && !before && pageMentions()) checked = new WeakSet();
  scan(document);
}

function startObserving() {
  const target = document.documentElement;
  if (!target || observing) return;
  observing = true;
  observer.observe(target, {
    childList: true, subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'alt', 'title', 'style', 'data-src', 'class']
  });
}

/* ---------- 先読みブラー ---------- */

let observing = false;
let prescanOn = false;
let prescanTimer = null;

// パース中に流れてくるノードに名前が含まれるか（軽い判定だけ）
function earlyMention(node) {
  const t = node.textContent;
  if (t && t.length <= 20000 && matchText(t)) return true;
  if (!node.getAttribute) return false;
  return matchText(node.getAttribute('alt')) || matchText(node.getAttribute('title')) ||
         matchText(node.getAttribute('content')) ||
         matchUrl(node.getAttribute('src')) || matchUrl(node.getAttribute('href'));
}

function prescan() {
  if (!settings.enabled || !settings.preMask || hostDisabled()) return;
  const root = document.documentElement;
  if (!root) return;
  root.style.setProperty('--ishiba-blur', (settings.blur || 18) + 'px');
  root.classList.add('ishiba-prescan');
  prescanOn = true;
  clearTimeout(prescanTimer);                       // 保険: 判定が走らなくても必ず解除する
  prescanTimer = setTimeout(releasePrescan, 1500);
}

function releasePrescan() {
  clearTimeout(prescanTimer);
  if (!prescanOn) return;
  prescanOn = false;
  document.documentElement.classList.remove('ishiba-prescan');
}

/* ---------- 起動 ---------- */

function hostDisabled() {
  const host = location.hostname;
  return (settings.disabledHosts || []).some(h => h && (host === h || host.endsWith('.' + h)));
}

function refreshKeywords() {
  const list = (settings.keywords || []).map(k => String(k).trim()).filter(Boolean);
  keywordRe = buildKeywordRe(list, 'i');
  keywordReGlobal = buildKeywordRe(list, 'gi');
}

function applySettings() {
  refreshKeywords();
  pageMentionsCache = null;
  checked = new WeakSet();
  tries = new WeakMap();
  unmaskAll();
  if (!settings.enabled || hostDisabled() || !settings.preMask) releasePrescan();
  if (!settings.enabled || hostDisabled()) return;
  if (document.body) document.body.classList.toggle('ishiba-peek', !!settings.peek);
  scan(document);
}

// document_start の時点で、既定値のまま監視と先読みブラーを始めておく
// （設定の読み込みを待つと、その間に画像が見えてしまうため）
refreshKeywords();
startObserving();
if (matchUrl(location.href) || matchText(document.title)) prescan();

chrome.storage.sync.get(DEFAULTS, res => {
  settings = { ...DEFAULTS, ...res };
  refreshKeywords();
  // 既定値で先に掛けたブラーを、実際の設定に合わせて解除する
  if (!settings.enabled || hostDisabled() || !settings.preMask) releasePrescan();
  if (!settings.enabled || hostDisabled()) { unmaskAll(); return; }
  startObserving();
  if (document.readyState !== 'loading') applySettings();
});

document.addEventListener('DOMContentLoaded', () => {
  checked = new WeakSet();     // パース中の判定は周辺テキストが未着だったのでやり直す
  pageMentionsCache = null;
  if (document.body) document.body.classList.toggle('ishiba-peek', !!settings.peek);
  scan(document);
  releasePrescan();
}, { once: true });

window.addEventListener('load', () => {
  checked = new WeakSet();
  pageMentionsCache = null;
  scan(document);
  releasePrescan();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  applySettings();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'ishiba-rescan') { applySettings(); sendResponse({ count: masked.size }); }
  if (msg && msg.type === 'ishiba-get-count') sendResponse({ count: masked.size });
  return true;
});
