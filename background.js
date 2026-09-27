chrome.action.setBadgeBackgroundColor({ color: '#8a7cff' });
chrome.action.setBadgeTextColor({ color: '#ffffff' });

// Badge is limited to ~4 characters: "2x", "1.5x", "0.75".
function badgeFor(speed) {
  if (!speed || speed === 1) return '';
  let t = String(Math.round(speed * 100) / 100);
  if (t.length <= 3) t += 'x';
  return t.slice(0, 4);
}

const ICON_PATHS = {
  16: 'icons/icon16.png',
  48: 'icons/icon48.png',
  128: 'icons/icon128.png',
};
let disabledIcons;

function getDisabledIcons() {
  if (!disabledIcons) {
    disabledIcons = Promise.all(Object.entries(ICON_PATHS).map(async ([size, path]) => {
      const response = await fetch(chrome.runtime.getURL(path));
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = new OffscreenCanvas(Number(size), Number(size));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = ctx.getImageData(0, 0, Number(size), Number(size));
      for (let i = 0; i < pixels.data.length; i += 4) {
        const gray = Math.round(0.2126 * pixels.data[i] + 0.7152 * pixels.data[i + 1] + 0.0722 * pixels.data[i + 2]);
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = gray;
      }
      return [size, pixels];
    })).then(Object.fromEntries).catch((error) => {
      disabledIcons = null;
      throw error;
    });
  }
  return disabledIcons;
}

// Track requests so a slow icon conversion can't overwrite a newer tab state.
const actionUpdates = new Map();
async function updateAction(tabId, settings = {}) {
  const request = {};
  actionUpdates.set(tabId, request);
  const icon = settings.disabled
    ? { imageData: await getDisabledIcons() }
    : { path: ICON_PATHS };
  if (actionUpdates.get(tabId) !== request) return;
  await Promise.all([
    chrome.action.setIcon({ tabId, ...icon }),
    chrome.action.setTitle({ tabId, title: settings.disabled ? 'Video X — disabled on this site' : 'Video X video controls' }),
    chrome.action.setBadgeText({ tabId, text: settings.disabled ? '' : badgeFor(settings.speed) }),
  ]);
}

async function refreshTabAction(tab) {
  if (!tab?.id) return;
  let settings = {};
  if (tab.url && /^https?:/.test(tab.url)) {
    const host = new URL(tab.url).hostname;
    const stored = await chrome.storage.sync.get(host);
    settings = stored[host] || (await chrome.storage.local.get(host))[host] || {};
  }
  await updateAction(tab.id, settings);
}

async function refreshActions() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map((tab) => refreshTabAction(tab).catch(() => {})));
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'vixdio:speed' && sender.tab && sender.frameId === 0) {
    updateAction(sender.tab.id, msg).catch(() => {});
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') refreshActions().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'loading' || change.status === 'complete') {
    refreshTabAction(tab).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(refreshTabAction).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => actionUpdates.delete(tabId));
chrome.runtime.onInstalled.addListener(() => { refreshActions().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { refreshActions().catch(() => {}); });

function togglePip() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }
  const vids = [...document.querySelectorAll('video')]
    .filter((v) => v.readyState >= 1 && !v.disablePictureInPicture)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  if (vids[0]) vids[0].requestPictureInPicture().catch(() => {});
}

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  if (tab.url) {
    const host = new URL(tab.url).hostname;
    const stored = await chrome.storage.sync.get(host);
    if (stored[host]?.disabled) return;
  }
  if (command === 'toggle-pip') {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, func: togglePip })
      .catch(() => {});
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'vixdio:command', command }).catch(() => {});
});
