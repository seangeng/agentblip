#!/usr/bin/env bash
# Renders demo-frame.html frame-by-frame with headless Chrome and encodes a
# looping GIF with ffmpeg. Every frame is a pure function of ?f=, so the output
# is deterministic. Usage: ./build-demo.sh [frames] [fps]
set -euo pipefail
cd "$(dirname "$0")"

FRAMES="${1:-60}"
FPS="${2:-12}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Rendering $FRAMES frames…"
for f in $(seq 0 $((FRAMES - 1))); do
  n=$(printf "%04d" "$f")
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size=2000,720 \
    --screenshot="$TMP/frame_$n.png" \
    "file://$PWD/demo-frame.html?f=$f&n=$FRAMES" >/dev/null 2>&1
done

echo "Encoding GIF…"
# two-pass palette for clean colors; downscale 2000->1000 for a crisp README gif
ffmpeg -y -framerate "$FPS" -i "$TMP/frame_%04d.png" \
  -vf "scale=1000:-1:flags=lanczos,palettegen=stats_mode=diff" "$TMP/pal.png" >/dev/null 2>&1
ffmpeg -y -framerate "$FPS" -i "$TMP/frame_%04d.png" -i "$TMP/pal.png" \
  -lavfi "scale=1000:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" \
  -loop 0 demo.gif >/dev/null 2>&1

echo "Wrote $PWD/demo.gif ($(du -h demo.gif | cut -f1))"
