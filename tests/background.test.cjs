const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  const calls = { icons: [], badges: [], titles: [] };
  const event = () => ({ addListener() {} });
  const presets = { 'disabled.example': { disabled: true, speed: 2 } };
  const context = vm.createContext({
    URL,
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => ({ close() {} }),
    OffscreenCanvas: class {
      getContext() {
        return { drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([138, 124, 255, 255]) }) };
      }
    },
    chrome: {
      action: {
        setBadgeBackgroundColor() {}, setBadgeTextColor() {},
        setIcon: async (value) => { calls.icons.push(value); },
        setTitle: async (value) => { calls.titles.push(value); },
        setBadgeText: async (value) => { calls.badges.push(value); },
      },
      runtime: { getURL: (path) => path, onMessage: event(), onInstalled: event(), onStartup: event() },
      storage: { sync: { get: async () => presets }, local: { get: async () => ({}) }, onChanged: event() },
      tabs: { onUpdated: event(), onActivated: event(), onRemoved: event() },
      commands: { onCommand: event() },
    },
  });
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), context);
  return { calls, run: (code) => vm.runInContext(code, context) };
}

test('disabled tabs get grayscale icons, explanatory title and no speed badge', async () => {
  const { calls, run } = setup();
  await run("refreshTabAction({ id: 1, url: 'https://disabled.example/watch' })");
  const icon = calls.icons[0];
  assert.equal(icon.tabId, 1);
  for (const size of [16, 48, 128]) {
    const pixel = icon.imageData[size].data;
    assert.equal(pixel[0], pixel[1]);
    assert.equal(pixel[1], pixel[2]);
    assert.equal(pixel[3], 255);
  }
  assert.equal(calls.badges[0].text, '');
  assert.match(calls.titles[0].title, /disabled on this site/);
  await run('updateAction(1, { disabled: false, speed: 1.5 })');
  assert.equal(calls.icons[1].path[16], 'icons/icon16.png');
  assert.equal(calls.badges[1].text, '1.5x');
});

test('navigation to an enabled site restores the normal icon for that tab', async () => {
  const { calls, run } = setup();
  await run("refreshTabAction({ id: 3, url: 'https://disabled.example' })");
  await run("refreshTabAction({ id: 3, url: 'https://enabled.example' })");
  assert.equal(calls.icons[1].tabId, 3);
  assert.equal(calls.icons[1].path[16], 'icons/icon16.png');
  assert.equal(calls.titles[1].title, 'Video X video controls');
});

test('rapid re-enable cannot be overwritten by pending grayscale generation', async () => {
  const { calls, run } = setup();
  await run('Promise.all([updateAction(1, { disabled: true }), updateAction(1, { disabled: false })])');
  assert.equal(calls.icons.length, 1);
  assert.equal(calls.icons[0].path[16], 'icons/icon16.png');
});
