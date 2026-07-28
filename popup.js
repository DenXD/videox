const DEFAULTS = {
  gamma: 1,
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hue: 0,
  speed: 1,
  preservePitch: true,
  volume: 100,
  bass: 0,
  treble: 0,
  nightMode: false,
  balance: 0,
  mono: false,
  renderMode: 'filter',
};

const FORMAT = {
  gamma: (v) => v.toFixed(2),
  brightness: (v) => `${v}%`,
  contrast: (v) => `${v}%`,
  saturation: (v) => `${v}%`,
  hue: (v) => `${v}°`,
  speed: (v) => `${v.toFixed(2)}x`,
  volume: (v) => `${v}%`,
  bass: (v) => (v > 0 ? `+${v}dB` : `${v}dB`),
  treble: (v) => (v > 0 ? `+${v}dB` : `${v}dB`),
  balance: (v) => (v === 0 ? 'C' : v < 0 ? `L${-v}` : `R${v}`),
};

const FALLBACK_NOTE = {
  cors: 'Enhanced unavailable here (video not CORS-enabled) — using regular.',
  protected: 'Enhanced unavailable here (protected/DRM video) — using regular.',
  unsupported: 'Enhanced unavailable here (no WebGL) — using regular.',
  detached: 'Video was replaced — reopen to retry enhanced.',
};

let settings = { ...DEFAULTS };
let tabId = null;
let host = null;
let saveTimer = null;

const statusEl = document.getElementById('status');
const noteEl = document.getElementById('mode-note');
const enhancedEl = document.getElementById('enhanced');

document.querySelectorAll('.vixdio-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.vixdio-tab').forEach((t) => t.classList.remove('is-active'));
    document.querySelectorAll('.vixdio-panel').forEach((p) => p.classList.remove('is-active'));
    tab.classList.add('is-active');
    document.querySelector(`.vixdio-panel[data-panel="${tab.dataset.tab}"]`).classList.add('is-active');
  });
});

function renderRow(row) {
  const key = row.dataset.key;
  const input = row.querySelector('input');
  if (input.type === 'checkbox') {
    input.checked = settings[key];
  } else {
    input.value = settings[key];
    row.querySelector('.vixdio-value').textContent = FORMAT[key](settings[key]);
  }
}

function renderEnhanced() {
  enhancedEl.checked = settings.renderMode === 'webgl';
  noteEl.textContent = '';
  noteEl.classList.remove('is-warn');
}

function renderAll() {
  document.querySelectorAll('.vixdio-row[data-key]').forEach(renderRow);
  renderEnhanced();
}

// The page reports which mode actually took effect, which can differ from the
// requested one when capture isn't permitted or nothing is being adjusted.
function showEffectiveMode(res) {
  if (!res) return;

  const label = res.activeMode === 'webgl' ? 'Enhanced' : 'Regular';
  const count = res.videos ? `${res.videos} video${res.videos > 1 ? 's' : ''}` : 'No video';
  statusEl.textContent = res.videos ? `${count} · ${label}` : count;

  if (settings.renderMode !== 'webgl' || res.activeMode === 'webgl') return;

  if (res.fallbackReason) {
    noteEl.textContent = FALLBACK_NOTE[res.fallbackReason] || FALLBACK_NOTE.unsupported;
  } else if (!res.hasAdjustment) {
    noteEl.textContent = 'Idle — move a picture slider for Enhanced to do anything.';
  } else {
    noteEl.textContent = 'Enhanced requested but not drawing — reload the page.';
  }
  noteEl.classList.add('is-warn');
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (host) chrome.storage.sync.set({ [host]: settings });
  }, 300);
}

function apply() {
  if (tabId === null) return;
  chrome.tabs.sendMessage(tabId, { type: 'vixdio:apply', settings }, (res) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = 'No video controls on this page';
      return;
    }
    showEffectiveMode(res);
  });
}

document.querySelectorAll('.vixdio-row[data-key]').forEach((row) => {
  const key = row.dataset.key;
  const input = row.querySelector('input');
  input.addEventListener('input', () => {
    settings[key] = input.type === 'checkbox' ? input.checked : Number(input.value);
    renderRow(row);
    apply();
    save();
  });
});

enhancedEl.addEventListener('change', () => {
  settings.renderMode = enhancedEl.checked ? 'webgl' : 'filter';
  renderEnhanced();
  apply();
  save();
});

document.getElementById('reset').addEventListener('click', () => {
  const mode = settings.renderMode;
  settings = { ...DEFAULTS, renderMode: mode };
  renderAll();
  apply();
  save();
});

function pipInPage() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }
  const vids = [...document.querySelectorAll('video')]
    .filter((v) => v.readyState >= 1 && !v.disablePictureInPicture)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
  if (vids[0]) vids[0].requestPictureInPicture().catch(() => {});
}

document.querySelectorAll('.vixdio-pip').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (tabId === null) return;
    chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: pipInPage,
    });
    window.close();
  });
});

document.getElementById('screenshot').addEventListener('click', () => {
  if (tabId === null) return;
  chrome.tabs.sendMessage(tabId, { type: 'vixdio:screenshot' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusEl.textContent = 'No video to capture';
      return;
    }
    if (!res.ok) {
      statusEl.textContent = 'Capture blocked (protected video)';
      return;
    }
    // Chrome silently drops anchor downloads of large data: URLs (~2MB cap),
    // so convert to a blob URL first.
    const bytes = atob(res.dataUrl.split(',')[1]);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `videox-${host}-${Date.now()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    statusEl.textContent = 'Frame saved';
  });
});

document.getElementById('forget').addEventListener('click', () => {
  if (host) {
    chrome.storage.sync.remove(host);
    chrome.storage.local.remove(host);
  }
  settings = { ...DEFAULTS };
  renderAll();
  apply();
  statusEl.textContent = 'Site preset cleared';
});

document.getElementById('shortcuts').addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    statusEl.textContent = "Can't control this page";
    renderAll();
    return;
  }
  tabId = tab.id;
  host = new URL(tab.url).hostname;
  document.getElementById('host').textContent = host;

  // Presets moved from local to sync storage; migrate old ones on sight.
  let stored = await chrome.storage.sync.get(host);
  if (!stored[host]) {
    stored = await chrome.storage.local.get(host);
    if (stored[host]) {
      chrome.storage.sync.set({ [host]: stored[host] });
      chrome.storage.local.remove(host);
    }
  }
  if (stored[host]) settings = { ...DEFAULTS, ...stored[host] };
  renderAll();

  chrome.tabs.sendMessage(tabId, { type: 'vixdio:status' }, (res) => {
    if (chrome.runtime.lastError || !res) {
      statusEl.textContent = 'No video found (reload the page)';
      return;
    }
    showEffectiveMode(res);
  });
}

init();
