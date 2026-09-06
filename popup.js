const DEFAULTS = {
  enabled: true, mode: 'blur', blur: 18, emoji: '🐈', replaceUrl: '',
  peek: true, preMask: true, maskText: false, minSize: 40, strictness: 'normal',
  keywords: ['石破', '石破茂', 'いしば', 'イシバ', 'Ishiba', 'ishiba', 'shigeru ishiba'],
  disabledHosts: []
};

const $ = id => document.getElementById(id);
let state = { ...DEFAULTS };
let host = '';

function radio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}

function render() {
  $('enabled').checked = state.enabled;
  document.querySelectorAll('input[name=mode]').forEach(r => r.checked = r.value === state.mode);
  document.querySelectorAll('input[name=strictness]').forEach(r => r.checked = r.value === state.strictness);
  $('blur').value = state.blur;
  $('blurVal').textContent = state.blur + 'px';
  $('emoji').value = state.emoji;
  $('replaceUrl').value = state.replaceUrl;
  $('peek').checked = state.peek;
  $('preMask').checked = state.preMask;
  $('maskText').checked = state.maskText;
  $('keywords').value = (state.keywords || []).join(', ');
  $('blurRow').style.display = state.mode === 'blur' ? '' : 'none';
  $('replaceRow').style.display = state.mode === 'replace' ? '' : 'none';
  const off = (state.disabledHosts || []).includes(host);
  $('hostBtn').textContent = host ? (off ? `${host} で有効にする` : `${host} では無効にする`) : '';
  $('hostBtn').style.display = host ? '' : 'none';
}

function save(patch) {
  state = { ...state, ...patch };
  chrome.storage.sync.set(patch);
  render();
}

$('enabled').onchange = e => save({ enabled: e.target.checked });
$('peek').onchange = e => save({ peek: e.target.checked });
$('preMask').onchange = e => save({ preMask: e.target.checked });
$('maskText').onchange = e => save({ maskText: e.target.checked });
$('blur').oninput = e => { $('blurVal').textContent = e.target.value + 'px'; save({ blur: +e.target.value }); };
$('emoji').oninput = e => save({ emoji: e.target.value });
$('replaceUrl').oninput = e => save({ replaceUrl: e.target.value.trim() });
$('keywords').onchange = e => save({
  keywords: e.target.value.split(/[,、\n]/).map(s => s.trim()).filter(Boolean)
});
document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => save({ mode: radio('mode') }));
document.querySelectorAll('input[name=strictness]').forEach(r =>
  r.onchange = () => save({ strictness: radio('strictness') }));

$('hostBtn').onclick = () => {
  const list = new Set(state.disabledHosts || []);
  list.has(host) ? list.delete(host) : list.add(host);
  save({ disabledHosts: [...list] });
};

chrome.storage.sync.get(DEFAULTS, res => {
  state = { ...DEFAULTS, ...res };
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    try { host = new URL(tab.url).hostname; } catch (e) { host = ''; }
    render();
    chrome.tabs.sendMessage(tab.id, { type: 'ishiba-get-count' }, r => {
      void chrome.runtime.lastError;
      if (r) $('count').textContent = `このページで ${r.count} 件`;
    });
  });
});
