// content.js の判定ロジックを最小のフェイク DOM で検査する
//   node test/detect.test.js
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

function classList() {
  const s = new Set();
  return { _s: s, add: c => s.add(c), remove: (...c) => c.forEach(x => s.delete(x)),
           contains: c => s.has(c), toggle: (c, v) => v ? s.add(c) : s.delete(c) };
}

function el(tag, attrs = {}, opts = {}) {
  const e = {
    tagName: tag.toUpperCase(), attrs, children: [], parentElement: null, nodeType: 1,
    style: { setProperty(){}, removeProperty(){} }, dataset: {}, classList: classList(),
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null },
    setAttribute(n, v) { this.attrs[n] = v }, removeAttribute(n) { delete this.attrs[n] },
    offsetWidth: opts.w ?? 300, offsetHeight: opts.h ?? 200,
    get textContent() { return opts.text ?? this.children.map(c => c.textContent).join('') },
    closest(sel) { let n = this; const t = sel.toUpperCase();
      while (n) { if (n.tagName === t) return n; n = n.parentElement } return null },
    querySelector() { return opts.figcaption || null },
    querySelectorAll() { return opts.all || [] },
  };
  return e;
}
function nest(parent, child) { child.parentElement = parent; parent.children.push(child); return parent; }

// content.js を新しい環境で評価する
function load({ title = '', href = 'https://example.com/news/123', stored = {}, readyState = 'complete' } = {}) {
  const listeners = {};
  const sandbox = {
    console, setTimeout, clearTimeout,
    location: { hostname: 'example.com', href },
    document: {
      readyState, title, body: null,
      documentElement: { classList: classList(), style: { setProperty(){}, removeProperty(){} } },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
      querySelectorAll() { return [] },
      createTreeWalker() { return { nextNode() { return null } } },
    },
    window: { addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) } },
    MutationObserver: class { constructor(cb) { sandbox._observerCb = cb } observe() {} },
    requestIdleCallback: null,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    getComputedStyle: () => ({ backgroundImage: 'none' }),
    chrome: {
      storage: { sync: { get: (d, cb) => cb(stored) }, onChanged: { addListener() {} } },
      runtime: { sendMessage() {}, onMessage: { addListener() {} } },
    },
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  sandbox._run = code => vm.runInContext(code, sandbox);
  sandbox._prescanning = () => sandbox.document.documentElement.classList.contains('ishiba-prescan');
  return sandbox;
}

let fail = 0;
const check = (name, got, want) => {
  if (got !== want) { console.log(`  NG ${name}: got ${got}, want ${want}`); fail++; }
  else console.log(`  ok ${name}`);
};

/* ---------- 画像の判定 ---------- */
let S = load();
let T = S.looksLikeTarget;

console.log('[normal モード]');
check('alt に石破', T(el('img', { alt: '記者会見する石破茂首相' })), true);
check('ファイル名 ishiba', T(el('img', { src: 'https://x.com/img/ishiba_2024.jpg' })), true);
check('URLエンコードされた石破', T(el('img', { src: 'https://x.com/%E7%9F%B3%E7%A0%B4.jpg' })), true);
check('無関係な画像', T(el('img', { alt: '国会議事堂', src: '/img/diet.jpg' })), false);
{
  const fig = el('figure'), img = el('img', { src: '/p/1.jpg' });
  const cap = el('figcaption', {}, { text: '石破首相＝首相官邸' });
  nest(fig, img); fig.querySelector = () => cap;
  check('figcaption 経由', T(img), true);
}
{
  const div = el('div', {}, { text: 'あ'.repeat(500) + '石破' });
  const img = el('img', { src: '/p/2.jpg' }); nest(div, img);
  check('長文の親は無視（誤爆防止）', T(img), false);
}
{
  const div = el('div', {}, { text: '石破前首相（写真）' });
  const img = el('img', { src: '/p/3.jpg' }); nest(div, img);
  check('短い親テキスト', T(img), true);
}

console.log('[strict モード]');
S._run("settings.strictness='strict'; pageMentionsCache=null;");
{
  const div = el('div', {}, { text: '石破前首相（写真）' });
  const img = el('img', { src: '/p/3.jpg' }); nest(div, img);
  check('周辺文は見ない', T(img), false);
  check('alt は見る', T(el('img', { alt: '石破' })), true);
}

console.log('[loose モード]');
S._run("settings.strictness='loose'; pageMentionsCache=null;");
S.document.body = { innerText: '本日、石破前首相は…' };
check('名前の出る記事の無関係画像', T(el('img', { alt: 'グラフ', src: '/g.png' })), true);
S.document.body = { innerText: '今日はいい天気です' };
S._run('pageMentionsCache=null;');
check('名前の出ないページ', T(el('img', { alt: 'グラフ', src: '/g.png' })), false);

console.log('[サイズ判定]');
check('16px アイコンは除外', S.tooSmall(el('img', {}, { w: 16, h: 16 })), true);
check('300px 写真', S.tooSmall(el('img', {}, { w: 300, h: 200 })), false);
check('未レイアウト(0px)は通す', S.tooSmall(el('img', {}, { w: 0, h: 0 })), false);

/* ---------- 先読みブラー（一瞬見えてしまう対策） ---------- */
console.log('[先読みブラー]');
const start = o => load({ readyState: 'loading', ...o });   // document_start 相当
check('URL に名前 → 起動直後にブラー', start({ href: 'https://x.com/news/ishiba' })._prescanning(), true);
check('title に名前 → 起動直後にブラー', start({ title: '石破前首相が会見' })._prescanning(), true);
check('無関係なページ → ブラーしない', start({ title: '天気予報' })._prescanning(), false);
check('preMask=false → ブラーしない',
      start({ title: '石破前首相が会見', stored: { preMask: false } })._prescanning(), false);
check('サイト無効 → ブラーしない',
      start({ title: '石破前首相が会見', stored: { disabledHosts: ['example.com'] } })._prescanning(), false);
{
  // パース中に名前のテキストが流れてきたら、その時点でブラーが掛かる
  const s = load({ title: '', readyState: 'loading' });
  check('パース中は未ブラー', s._prescanning(), false);
  s._observerCb([{ type: 'childList', addedNodes: [{ nodeType: 3, data: '石破前首相は' }] }]);
  check('名前のテキスト到着でブラー', s._prescanning(), true);
}
{
  // 挿入と同時にマスクされる（描画前に間に合う）
  const s = load();
  const img = el('img', { alt: '石破茂首相' });
  s._observerCb([{ type: 'childList', addedNodes: [img] }]);
  check('挿入直後に同期マスク', img.classList.contains('ishiba-masked'), true);
  const ok = el('img', { alt: '国会議事堂' });
  s._observerCb([{ type: 'childList', addedNodes: [ok] }]);
  check('無関係な画像は素通し', ok.classList.contains('ishiba-masked'), false);
}
{
  // スキャンが済んだらブラー解除
  const s = load({ title: '石破前首相が会見', readyState: 'loading' });
  check('スキャン前は保持', s._prescanning(), true);
  s.document.readyState = 'complete';        // 読み込み完了 → 判定が済むので解除される
  s._run('scan(document)');
  check('スキャン後に解除', s._prescanning(), false);
}

console.log(fail ? `\n${fail} 件 NG` : '\nすべて OK');
process.exit(fail ? 1 : 0);
