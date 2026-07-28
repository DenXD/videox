chrome.action.setBadgeBackgroundColor({ color: '#8a7cff' });
chrome.action.setBadgeTextColor({ color: '#ffffff' });

// Badge is limited to ~4 characters: "2x", "1.5x", "0.75".
function badgeFor(speed) {
  if (!speed || speed === 1) return '';
  let t = String(Math.round(speed * 100) / 100);
  if (t.length <= 3) t += 'x';
  return t.slice(0, 4);
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'vixdio:speed' && sender.tab) {
    chrome.action.setBadgeText({ tabId: sender.tab.id, text: badgeFor(msg.speed) });
  }
});

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
  if (command === 'toggle-pip') {
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, func: togglePip })
      .catch(() => {});
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'vixdio:command', command }).catch(() => {});
});
