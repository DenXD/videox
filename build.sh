#!/bin/sh
# Package the extension for Chrome Web Store upload.
set -e
cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT="videox-$VERSION.zip"
rm -f "$OUT"
zip -r "$OUT" manifest.json background.js content.js webgl.js popup.html popup.css popup.js icons
echo "Created $OUT"
