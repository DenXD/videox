# Video X

Chrome extension that adds picture and audio controls to any video on any site.

## Features

- **Picture** — gamma (true gamma correction via SVG filter, works on DRM sites), brightness, contrast, saturation, hue
- **Enhanced quality mode** — optional WebGL renderer with float-precision color math and dithering for smoother dark scenes; falls back automatically on DRM / non-CORS video
- **Playback** — speed 0.25x–4x with pitch preservation, keyboard shortcuts, speed badge on the toolbar icon
- **Audio** — volume boost up to 400%, bass/treble EQ, night mode (dialog compressor), balance, mono downmix
- **Extras** — pop out video (Picture-in-Picture), frame screenshot with filters applied, per-site presets synced across Chrome profiles

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+.` | Speed +0.25x |
| `Alt+,` | Speed −0.25x |
| `Alt+0` | Reset speed |
| `Alt+P` | Pop out video |

Customize at `chrome://extensions/shortcuts`.

## Install (development)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this folder

## Package for Chrome Web Store

```sh
./build.sh
```

Produces `videox-<version>.zip` ready for upload to the [developer dashboard](https://chrome.google.com/webstore/devconsole).

## Structure

- `manifest.json` — Manifest V3
- `content.js` — applies settings to `<video>` elements (filters, speed, Web Audio graph)
- `webgl.js` — enhanced-mode shader renderer
- `background.js` — keyboard commands, toolbar badge
- `popup.*` — tabbed settings UI

## Privacy

No data collection of any kind — see [PRIVACY.md](PRIVACY.md).
