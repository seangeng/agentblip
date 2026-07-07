#!/usr/bin/env bash
# Builds a release binary and wraps it into agentblip.app — a menu-bar agent
# (LSUIElement, no dock icon). No Xcode project needed; pure SwiftPM + bundling.
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="agentblip"
BUNDLE_ID="org.npclabs.agentblip.menubar"
VERSION="${1:-0.1.0}"
OUT="${OUT:-dist}"

echo "Building release binary…"
swift build -c release

BIN="$(swift build -c release --show-bin-path)/AgentblipMenuBar"
APP="$OUT/$APP_NAME.app"
CONTENTS="$APP/Contents"

rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN" "$CONTENTS/MacOS/$APP_NAME"
chmod +x "$CONTENTS/MacOS/$APP_NAME"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>$APP_NAME</string>
    <key>CFBundleDisplayName</key><string>agentblip</string>
    <key>CFBundleExecutable</key><string>$APP_NAME</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>$VERSION</string>
    <key>CFBundleShortVersionString</key><string>$VERSION</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <!-- Menu-bar agent: no dock icon, no main window. -->
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

echo "Built $APP"
echo "Run it:  open \"$APP\"    (or double-click)"
echo
echo "Unsigned build — first launch: right-click → Open, or"
echo "  xattr -dr com.apple.quarantine \"$APP\"   to clear Gatekeeper."
