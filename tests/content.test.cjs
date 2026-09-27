const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function setup(preset) {
  const listeners = {};
  let storageListener;
  const video = {
    style: { filter: 'sepia(0.2)' }, playbackRate: 1.25, preservesPitch: true,
    volume: 0.4, isConnected: true,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800 }),
  };
  const context = vm.createContext({
    document: {
      querySelectorAll: () => [video],
      getElementById: () => null,
      addEventListener: (name, fn) => { listeners[name] = fn; },
      documentElement: {},
    },
    window: { addEventListener() {}, innerWidth: 1200 },
    location: { hostname: 'example.com' },
    MutationObserver: class { observe() {} },
    chrome: {
      runtime: { onMessage: { addListener() {} }, sendMessage: async () => {} },
      storage: {
        sync: { get: async () => preset ? { 'example.com': preset } : {}, set: async () => {} },
        local: { get: async () => ({}) },
        onChanged: { addListener(fn) { storageListener = fn; } },
      },
    },
    setTimeout, clearTimeout,
  });
  vm.runInContext('window.top = window', context);
  vm.runInContext(fs.readFileSync('content.js', 'utf8'), context);
  await new Promise(setImmediate);
  return { video, listeners, run: (code) => vm.runInContext(code, context), change: (value) => storageListener({ 'example.com': { newValue: value } }, 'sync') };
}

test('disable restores original video settings and enable reapplies the saved preset', async () => {
  const { video, run } = await setup();
  run('updateSettings({ ...DEFAULTS, brightness: 150, speed: 2, volume: 50, volumeEnabled: true })');
  assert.equal(video.style.filter, 'brightness(1.5)');
  assert.equal(video.playbackRate, 2);
  run('updateSettings({ ...settings, disabled: true })');
  assert.equal(video.style.filter, 'sepia(0.2)');
  assert.equal(video.playbackRate, 1.25);
  assert.equal(video.volume, 0.4);
  run("handleCommand('speed-up'); applyToVideo(document.querySelectorAll()[0])");
  assert.equal(video.playbackRate, 1.25);
  assert.equal(run('settings.speed'), 2);
  run('updateSettings({ ...settings, disabled: false })');
  assert.equal(video.playbackRate, 2);
  assert.equal(video.style.filter, 'brightness(1.5)');
});

test('saved disabled sites leave playback and keyboard events untouched; storage updates enable them', async () => {
  const { video, listeners, run, change } = await setup({ disabled: true, speed: 2 });
  assert.equal(video.playbackRate, 1.25);
  listeners.keydown({ code: 'KeyD', preventDefault() { throw Error('Intercepted disabled shortcut'); } });
  assert.equal(run('statusPayload().disabled'), true);
  change({ disabled: false, speed: 2 });
  assert.equal(video.playbackRate, 2);
  change({ disabled: true, speed: 2 });
  assert.equal(video.playbackRate, 1.25);
});

test('overlay is inset at top-left and clamped into the viewport', async () => {
  const { run, video } = await setup();
  run("overlay = { style: {}, offsetWidth: 340 }; overlayVideo = document.querySelectorAll()[0]; positionOverlay()");
  assert.equal(run('overlay.style.left'), '110px');
  assert.equal(run('overlay.style.top'), '60px');
  assert.equal(run('overlay.style.transform'), 'none');
  video.getBoundingClientRect = () => ({ left: -100, top: -100 });
  run('positionOverlay()');
  assert.equal(run('overlay.style.left'), '10px');
  assert.equal(run('overlay.style.top'), '10px');
});

test('disable bypasses an existing audio processing graph', async () => {
  const { run } = await setup();
  run(`
    updateSettings({ ...DEFAULTS, speed: 2 });
    const routes = [];
    const destination = {};
    const source = { disconnect() { routes.push('disconnect'); }, connect(target) { routes.push(target); } };
    const nodes = { source, ctx: { destination } };
    audioNodes.set(document.querySelectorAll()[0], nodes);
    updateSettings({ ...settings, disabled: true });
  `);
  assert.equal(run('nodes.bypassed'), true);
  assert.equal(run("routes[0] === 'disconnect' && routes[1] === destination"), true);
});

test('unchecked volume never writes volume during picture changes, playback, or site disable', async () => {
  const { video, run } = await setup({ brightness: 120, volume: 80, bass: 6 });
  assert.equal(video.volume, 0.4, 'legacy presets must leave volume under site control');
  let siteVolume = 0.25;
  Object.defineProperty(video, 'volume', {
    get: () => siteVolume,
    set() { throw Error('Extension wrote volume while unchecked'); },
  });
  run('updateSettings({ ...settings, brightness: 150 }); applyAll()');
  siteVolume = 0.65;
  run('applyToVideo(document.querySelectorAll()[0])');
  run('updateSettings({ ...settings, disabled: true })');
  assert.equal(video.volume, 0.65);
});

test('volume opt-in applies saved level and opt-out leaves subsequent site changes alone', async () => {
  const { video, run, change } = await setup();
  change({ volumeEnabled: true, volume: 70 });
  assert.equal(video.volume, 0.7);
  change({ volumeEnabled: false, volume: 70 });
  assert.equal(video.volume, 0.7, 'unchecking should not jump to another volume');
  video.volume = 0.2;
  run('updateSettings({ ...settings, brightness: 130 }); applyAll()');
  assert.equal(video.volume, 0.2);
  change({ volumeEnabled: true, volume: 70 });
  assert.equal(video.volume, 0.7);
  run('updateSettings({ ...settings, disabled: true })');
  assert.equal(video.volume, 0.2, 'restore volume captured at opt-in, not page load');
});

test('unchecking volume bypasses audio effects without changing native volume', async () => {
  const { video, run } = await setup();
  run(`
    updateSettings({ ...DEFAULTS, volumeEnabled: true, volume: 60 });
    const routes = [];
    const destination = {};
    const nodes = {
      source: { disconnect() { routes.push('disconnect'); }, connect(target) { routes.push(target); } },
      ctx: { destination },
    };
    audioNodes.set(document.querySelectorAll()[0], nodes);
    updateSettings({ ...settings, volumeEnabled: false });
    applyAll();
  `);
  assert.equal(video.volume, 0.6);
  assert.equal(run('nodes.bypassed'), true);
  assert.equal(run('routes.length'), 2, 'bypass routing only once');
  assert.equal(run('routes[1] === destination'), true);
});

test('gamma, speed and contrast labels update immediately even when extension APIs are invalidated', async () => {
  const { run } = await setup();
  run(`
    const labels = { speed: { textContent: '' }, gamma: { textContent: '' }, contrast: { textContent: '' } };
    overlay = { querySelector(selector) { return labels[selector.match(/data-val="([^"]+)"/)[1]]; } };
    ensureGammaFilter = () => {};
    chrome.storage.sync.set = () => { throw Error('Extension context invalidated.'); };
    chrome.runtime.sendMessage = () => { throw Error('Extension context invalidated.'); };
    refreshOverlay();
  `);
  assert.doesNotThrow(() => run("overlayAction('gamma-up')"));
  assert.equal(run('labels.gamma.textContent'), 'γ1.10');
  assert.doesNotThrow(() => run("overlayAction('gamma-up')"));
  assert.equal(run('labels.gamma.textContent'), 'γ1.20');
  assert.doesNotThrow(() => run("overlayAction('speed-up')"));
  assert.equal(run('labels.speed.textContent'), '1.25x');
  assert.doesNotThrow(() => run("overlayAction('contrast-up')"));
  assert.equal(run('labels.contrast.textContent'), 'C105%');
  assert.doesNotThrow(() => run("overlayAction('contrast-down')"));
  assert.equal(run('labels.contrast.textContent'), 'C100%');
});
