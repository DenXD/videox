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

// Keys that actually change the video; renderMode alone is a no-op.
const ADJUST_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'renderMode');

let settings = { ...DEFAULTS };
let fallbackReason = null;

// video -> { ctx, gain, bass, treble, comp, mono, pan } audio chain
const audioNodes = new WeakMap();
// video -> VixdioRenderer for enhanced mode
const renderers = new Map();

const IS_TOP = window === window.top;

// Top-level hostname, so iframes (e.g. embedded players) share the
// same per-site preset as the page that embeds them.
function getTopHost() {
  try {
    if (IS_TOP) return location.hostname;
    const origins = location.ancestorOrigins;
    if (origins && origins.length) {
      return new URL(origins[origins.length - 1]).hostname;
    }
  } catch (e) {}
  return location.hostname;
}

const TOP_HOST = getTopHost();

function ensureGammaFilter() {
  let svg = document.getElementById('vixdio-svg');
  if (!svg) {
    svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'vixdio-svg';
    svg.setAttribute('style', 'position:absolute;width:0;height:0;pointer-events:none');
    svg.innerHTML =
      '<filter id="vixdio-gamma" color-interpolation-filters="sRGB">' +
      '<feComponentTransfer>' +
      '<feFuncR type="gamma" amplitude="1" exponent="1" offset="0"/>' +
      '<feFuncG type="gamma" amplitude="1" exponent="1" offset="0"/>' +
      '<feFuncB type="gamma" amplitude="1" exponent="1" offset="0"/>' +
      '</feComponentTransfer>' +
      '</filter>';
    (document.body || document.documentElement).appendChild(svg);
  }
  const exponent = String(1 / settings.gamma);
  svg.querySelectorAll('feFuncR, feFuncG, feFuncB').forEach((fn) => {
    fn.setAttribute('exponent', exponent);
  });
  return svg;
}

function buildFilterValue() {
  const parts = [];
  if (settings.gamma !== 1) {
    ensureGammaFilter();
    parts.push('url(#vixdio-gamma)');
  }
  if (settings.brightness !== 100) parts.push(`brightness(${settings.brightness / 100})`);
  if (settings.contrast !== 100) parts.push(`contrast(${settings.contrast / 100})`);
  if (settings.saturation !== 100) parts.push(`saturate(${settings.saturation / 100})`);
  if (settings.hue !== 0) parts.push(`hue-rotate(${settings.hue}deg)`);
  return parts.join(' ');
}

function needsAudioGraph() {
  return (
    settings.volume > 100 ||
    settings.bass !== 0 ||
    settings.treble !== 0 ||
    settings.nightMode ||
    settings.balance !== 0 ||
    settings.mono
  );
}

function applyAudio(video) {
  const boost = settings.volume / 100;
  let nodes = audioNodes.get(video);

  // Don't touch the audio routing until a graph feature is actually used —
  // createMediaElementSource silences CORS-restricted media, so it must
  // stay opt-in.
  if (!nodes && !needsAudioGraph()) {
    video.volume = Math.min(boost, 1);
    return;
  }

  if (!nodes) {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      const bass = ctx.createBiquadFilter();
      bass.type = 'lowshelf';
      bass.frequency.value = 200;
      const treble = ctx.createBiquadFilter();
      treble.type = 'highshelf';
      treble.frequency.value = 3500;
      const comp = ctx.createDynamicsCompressor();
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'max';
      const pan = ctx.createStereoPanner();
      source
        .connect(gain)
        .connect(bass)
        .connect(treble)
        .connect(comp)
        .connect(mono)
        .connect(pan)
        .connect(ctx.destination);
      nodes = { ctx, gain, bass, treble, comp, mono, pan };
      audioNodes.set(video, nodes);
    } catch (e) {
      // Source already claimed (another extension) or CORS-restricted media.
      return;
    }
  }

  video.volume = boost > 1 ? 1 : boost;
  nodes.gain.gain.value = boost > 1 ? boost : 1;
  nodes.bass.gain.value = settings.bass;
  nodes.treble.gain.value = settings.treble;

  const c = nodes.comp;
  if (settings.nightMode) {
    c.threshold.value = -45;
    c.knee.value = 30;
    c.ratio.value = 10;
    c.attack.value = 0.003;
    c.release.value = 0.3;
  } else {
    // Neutral: ratio 1 means no compression is applied.
    c.threshold.value = 0;
    c.knee.value = 0;
    c.ratio.value = 1;
    c.attack.value = 0.003;
    c.release.value = 0.25;
  }

  // Forcing the node to one channel downmixes; destination upmixes back.
  nodes.mono.channelCountMode = settings.mono ? 'explicit' : 'max';
  nodes.pan.pan.value = settings.balance / 100;

  if (nodes.ctx.state === 'suspended') nodes.ctx.resume().catch(() => {});
}

function teardownRenderer(video) {
  const r = renderers.get(video);
  if (r) {
    r.destroy();
    renderers.delete(video);
  }
}

// Enhanced mode couldn't capture this video — drop every renderer back to the
// filter path so the whole page stays visually consistent.
function onRendererFallback(reason) {
  fallbackReason = reason;
  renderers.forEach((r) => r.destroy());
  renderers.clear();
  document.querySelectorAll('video').forEach(applyPicture);
}

function hasAdjustment() {
  return (
    settings.gamma !== 1 ||
    settings.brightness !== 100 ||
    settings.contrast !== 100 ||
    settings.saturation !== 100 ||
    settings.hue !== 0
  );
}

function applyPicture(video) {
  const wantsEnhanced = settings.renderMode === 'webgl' && !fallbackReason;

  if (!wantsEnhanced || !hasAdjustment()) {
    teardownRenderer(video);
    video.style.filter = hasAdjustment() ? buildFilterValue() : '';
    return;
  }

  video.style.filter = '';
  let r = renderers.get(video);
  if (r) {
    r.update(settings);
    return;
  }
  r = new VixdioRenderer(video, settings, onRendererFallback);
  if (r.start()) {
    renderers.set(video, r);
  } else {
    // WebGL unavailable in this context (blocked, or no GPU) — use the filter.
    fallbackReason = 'unsupported';
    video.style.filter = buildFilterValue();
  }
}

function applyToVideo(video) {
  applyPicture(video);
  video.playbackRate = settings.speed;
  if ('preservesPitch' in video) video.preservesPitch = settings.preservePitch;
  applyAudio(video);
}

function applyAll() {
  const videos = document.querySelectorAll('video');
  videos.forEach(applyToVideo);
  return videos.length;
}

function isDefault() {
  return ADJUST_KEYS.every((k) => settings[k] === DEFAULTS[k]);
}

// Report what is genuinely on screen, not what was requested: enhanced mode
// only counts as active once a renderer is actually drawing.
function statusPayload() {
  const enhanced = settings.renderMode === 'webgl' && !fallbackReason && renderers.size > 0;
  return {
    videos: document.querySelectorAll('video').length,
    activeMode: enhanced ? 'webgl' : 'filter',
    rendering: renderers.size,
    hasAdjustment: hasAdjustment(),
    fallbackReason,
  };
}

function notifySpeed() {
  if (!IS_TOP) return;
  chrome.runtime.sendMessage({ type: 'vixdio:speed', speed: settings.speed }).catch(() => {});
}

function persist() {
  if (!IS_TOP || bypassStash) return;
  chrome.storage.sync.set({ [TOP_HOST]: settings }).catch(() => {});
}

// Hold-to-compare: temporarily show the unfiltered picture without touching
// the saved configuration. Only picture keys are bypassed — speed and audio
// stay, so playback doesn't hiccup during the comparison.
const PICTURE_KEYS = ['gamma', 'brightness', 'contrast', 'saturation', 'hue'];
let bypassStash = null;
let bypassTimer = null;

function setBypass(on) {
  if (on === !!bypassStash) return;
  if (on) {
    bypassStash = { ...settings };
    PICTURE_KEYS.forEach((k) => {
      settings[k] = DEFAULTS[k];
    });
    // Never leave the preview stuck if the release event is lost
    // (e.g. the popup closes while the button is held).
    bypassTimer = setTimeout(() => setBypass(false), 15000);
  } else {
    clearTimeout(bypassTimer);
    settings = bypassStash;
    bypassStash = null;
  }
  applyAll();
  refreshOverlay();
}

let toastTimer = null;
function toast(text) {
  if (!IS_TOP) return;
  let el = document.getElementById('vixdio-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'vixdio-toast';
    el.style.cssText =
      'position:fixed;top:16px;left:16px;z-index:2147483647;' +
      'background:rgba(22,22,30,.88);color:#fff;padding:6px 14px;border-radius:8px;' +
      'font:600 14px -apple-system,BlinkMacSystemFont,sans-serif;' +
      'pointer-events:none;transition:opacity .2s;opacity:0';
    document.documentElement.appendChild(el);
  }
  // Only the fullscreen subtree renders while fullscreen is active.
  const host = document.fullscreenElement || document.documentElement;
  if (el.parentElement !== host) host.appendChild(el);
  el.textContent = text;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
  }, 900);
}

function handleCommand(command, showToast = true) {
  setBypass(false);
  if (command === 'speed-up') {
    settings.speed = Math.min(4, Math.round((settings.speed + 0.25) * 100) / 100);
  } else if (command === 'speed-down') {
    settings.speed = Math.max(0.25, Math.round((settings.speed - 0.25) * 100) / 100);
  } else if (command === 'speed-reset') {
    settings.speed = 1;
  } else {
    return;
  }
  applyAll();
  persist();
  notifySpeed();
  if (showToast) toast(`${settings.speed}x`);
}

// ---- on-video hover controls (work in fullscreen, where the popup can't) ----

const OVERLAY_CSS =
  '.vixdio-overlay{position:fixed;z-index:2147483647;display:flex;align-items:center;gap:2px;' +
  'background:rgba(20,20,30,.5);border-radius:10px;padding:5px 8px;' +
  'font-family:-apple-system,BlinkMacSystemFont,sans-serif;font-size:13px;color:#e6e6ef;' +
  'opacity:0;transition:opacity .15s;pointer-events:none;' +
  'user-select:none;-webkit-user-select:none}' +
  '.vixdio-overlay.is-visible{opacity:.3;pointer-events:auto}' +
  '.vixdio-overlay.is-visible:hover{opacity:1}' +
  '.vixdio-overlay button{background:none;border:none;color:#e6e6ef;font-size:14px;' +
  'width:26px;height:24px;border-radius:6px;cursor:pointer;line-height:1;padding:0}' +
  '.vixdio-overlay button:hover{background:rgba(138,124,255,.4)}' +
  '.vixdio-ov-val{min-width:46px;text-align:center;color:#c9c2ff;font-variant-numeric:tabular-nums}' +
  '.vixdio-ov-sep{width:1px;height:16px;background:rgba(255,255,255,.18);margin:0 4px}';

let overlay = null;
let overlayVideo = null;
let overlayTimer = null;
let overlayThrottle = 0;

function overlayAction(act) {
  if (act !== 'peek') setBypass(false);
  if (act === 'speed-down' || act === 'speed-up') {
    handleCommand(act, false);
  } else if (act === 'gamma-down' || act === 'gamma-up') {
    const d = act === 'gamma-up' ? 0.1 : -0.1;
    settings.gamma = Math.min(2.5, Math.max(0.5, Math.round((settings.gamma + d) * 100) / 100));
    applyAll();
    persist();
  } else if (act === 'pip' && overlayVideo && overlayVideo.isConnected) {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture().catch(() => {});
    } else {
      overlayVideo.requestPictureInPicture().catch(() => {});
    }
  } else if (act === 'reset') {
    settings = { ...DEFAULTS, renderMode: settings.renderMode };
    applyAll();
    persist();
    notifySpeed();
  }
  refreshOverlay();
}

function ensureOverlay() {
  if (overlay) return overlay;
  const style = document.createElement('style');
  style.id = 'vixdio-overlay-style';
  style.textContent = OVERLAY_CSS;
  (document.head || document.documentElement).appendChild(style);

  overlay = document.createElement('div');
  overlay.className = 'vixdio-overlay';
  overlay.innerHTML =
    '<button data-act="speed-down" title="Slower">−</button>' +
    '<span class="vixdio-ov-val" data-val="speed"></span>' +
    '<button data-act="speed-up" title="Faster">+</button>' +
    '<span class="vixdio-ov-sep"></span>' +
    '<button data-act="gamma-down" title="Gamma down">−</button>' +
    '<span class="vixdio-ov-val" data-val="gamma"></span>' +
    '<button data-act="gamma-up" title="Gamma up">+</button>' +
    '<span class="vixdio-ov-sep"></span>' +
    '<button data-act="peek" title="Hold to see original">👁</button>' +
    '<button data-act="pip" title="Pop out video">⧉</button>' +
    '<button data-act="reset" title="Reset all">↺</button>';
  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.act === 'peek') return;
    e.preventDefault();
    e.stopPropagation();
    overlayAction(btn.dataset.act);
  });
  overlay.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.act !== 'peek') return;
    e.preventDefault();
    e.stopPropagation();
    setBypass(true);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) =>
    overlay.addEventListener(ev, () => setBypass(false))
  );
  return overlay;
}

function refreshOverlay() {
  if (!overlay) return;
  overlay.querySelector('[data-val="speed"]').textContent = `${settings.speed}x`;
  overlay.querySelector('[data-val="gamma"]').textContent = `γ${settings.gamma.toFixed(2)}`;
}

function showOverlay(video) {
  ensureOverlay();
  // Only elements inside the fullscreen subtree render while fullscreen.
  const fs = document.fullscreenElement;
  const host =
    fs && fs !== video && fs.contains(video) ? fs : document.body || document.documentElement;
  if (overlay.parentElement !== host) host.appendChild(overlay);
  overlayVideo = video;
  refreshOverlay();
  const rect = video.getBoundingClientRect();
  overlay.style.left = `${rect.left + rect.width / 2}px`;
  overlay.style.top = `${Math.max(rect.top + 10, 10)}px`;
  overlay.style.transform = 'translateX(-50%)';
  overlay.classList.add('is-visible');
}

function hideOverlay() {
  if (overlay) overlay.classList.remove('is-visible');
}

function videoAtPoint(x, y) {
  let best = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) continue;
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const area = r.width * r.height;
    if (area > bestArea) {
      best = v;
      bestArea = area;
    }
  }
  return best;
}

document.addEventListener(
  'mousemove',
  (e) => {
    const now = Date.now();
    if (now - overlayThrottle < 100) return;
    overlayThrottle = now;
    if (overlay && overlay.contains(e.target)) {
      clearTimeout(overlayTimer);
      overlayTimer = setTimeout(hideOverlay, 2500);
      return;
    }
    const video = videoAtPoint(e.clientX, e.clientY);
    clearTimeout(overlayTimer);
    if (video) {
      showOverlay(video);
      overlayTimer = setTimeout(hideOverlay, 2500);
    } else if (overlay) {
      overlayTimer = setTimeout(hideOverlay, 300);
    }
  },
  true
);

document.addEventListener('fullscreenchange', hideOverlay);

// Player keys on every site: S/D speed, and YouTube-style J/K/L
// (back 10s / play-pause / forward 10s). Ignored while typing.
document.addEventListener(
  'keydown',
  (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    // Physical key position, not the typed character — works on any
    // keyboard layout (Cyrillic, AZERTY, ...).
    const key = { KeyS: 's', KeyD: 'd', KeyJ: 'j', KeyK: 'k', KeyL: 'l' }[e.code];
    if (!key) return;
    const t = e.target;
    if (
      t &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
    ) {
      return;
    }
    const video = primaryVideo();
    if (!video) return;
    e.preventDefault();
    e.stopPropagation();
    if (key === 's' || key === 'd') {
      handleCommand(key === 's' ? 'speed-down' : 'speed-up');
      refreshOverlay();
    } else if (key === 'j') {
      video.currentTime = Math.max(0, video.currentTime - 10);
      toast('« 10s');
    } else if (key === 'l') {
      const d = video.duration;
      video.currentTime = isFinite(d)
        ? Math.min(d, video.currentTime + 10)
        : video.currentTime + 10;
      toast('10s »');
    } else if (key === 'k') {
      if (video.paused) {
        video.play().catch(() => {});
        toast('▶');
      } else {
        video.pause();
        toast('❚❚');
      }
    }
  },
  true
);

// Pick the most prominent playable video for screenshot.
function primaryVideo() {
  return [...document.querySelectorAll('video')]
    .filter((v) => v.readyState >= 2)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
}

function captureFrame() {
  const video = primaryVideo();
  if (!video) return null;

  const r = renderers.get(video);
  if (r && r.canvas) {
    return { ok: true, dataUrl: r.canvas.toDataURL('image/png') };
  }

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (hasAdjustment()) ctx.filter = buildFilterValue();
  try {
    ctx.drawImage(video, 0, 0);
    return { ok: true, dataUrl: canvas.toDataURL('image/png') };
  } catch (e) {
    return { ok: false, error: 'protected' };
  }
}

// Catch videos created or started after page load.
document.addEventListener(
  'play',
  (e) => {
    if (e.target instanceof HTMLVideoElement && !isDefault()) applyToVideo(e.target);
  },
  true
);

new MutationObserver((mutations) => {
  // Drop renderers whose video left the DOM.
  renderers.forEach((r, video) => {
    if (!video.isConnected) teardownRenderer(video);
  });
  if (isDefault()) return;
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node instanceof HTMLVideoElement) applyToVideo(node);
      else if (node.querySelector) node.querySelectorAll('video').forEach(applyToVideo);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'vixdio:bypass') {
    setBypass(msg.on);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'vixdio:apply') {
    setBypass(false);
    const modeChanged = msg.settings.renderMode !== settings.renderMode;
    settings = { ...DEFAULTS, ...msg.settings };
    // Give a mode switch a clean slate so a previous failure isn't sticky.
    if (modeChanged) {
      fallbackReason = null;
      renderers.forEach((r) => r.destroy());
      renderers.clear();
    }
    applyAll();
    notifySpeed();
    refreshOverlay();
    sendResponse(statusPayload());
  } else if (msg.type === 'vixdio:status') {
    sendResponse(statusPayload());
  } else if (msg.type === 'vixdio:command') {
    handleCommand(msg.command);
  } else if (msg.type === 'vixdio:screenshot') {
    // Only frames that actually hold a video answer, so the popup gets the
    // response from the right frame.
    const shot = captureFrame();
    if (shot) sendResponse(shot);
  }
});

// Reapply the saved per-site preset on page load (sync first, legacy local).
async function loadPreset() {
  let stored = await chrome.storage.sync.get(TOP_HOST);
  if (!stored[TOP_HOST]) stored = await chrome.storage.local.get(TOP_HOST);
  if (stored[TOP_HOST]) {
    settings = { ...DEFAULTS, ...stored[TOP_HOST] };
    applyAll();
    notifySpeed();
  }
}
loadPreset();
