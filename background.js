/* MaskIshiba - service worker: マスクした枚数をバッジに出す */

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'ishiba-count' || !sender.tab) return;
  const tabId = sender.tab.id;
  const text = msg.count > 0 ? String(msg.count) : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#c0392b' }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, cur => {
    if (!cur || Object.keys(cur).length === 0) {
      chrome.storage.sync.set({
        enabled: true, mode: 'blur', blur: 18, emoji: '🐈', replaceUrl: '',
        peek: false, preMask: true, maskText: false, minSize: 40, strictness: 'normal',
        keywords: ['石破', '石破茂', 'いしば', 'イシバ', 'Ishiba', 'ishiba', 'shigeru ishiba'],
        disabledHosts: []
      });
    }
  });
});
