#!/bin/bash
# Build "PortalCast Server.app" around a bundle from build-bundle.mjs and wrap it in a .dmg.
#   packaging/macos/build-dmg.sh <bundle dir> <version> <arch: arm64|x64> <out dir>
# Runs on macOS (hdiutil, iconutil, sips).
#
# The app has no window (LSUIElement). Opening it installs a per-user LaunchAgent
# (~/Library/LaunchAgents/com.portalcast.server.plist: start at login, restart if it
# stops) pointing at the server inside the app, then opens http://localhost:3000.
# Config + data: ~/Library/Application Support/PortalCast. Log: ~/Library/Logs/PortalCast.
set -euo pipefail
BUNDLE="$1"; VERSION="$2"; ARCH="$3"; OUT="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)"
APP="$STAGE/PortalCast Server.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$BUNDLE" "$APP/Contents/Resources/portalcast"

cat > "$APP/Contents/MacOS/PortalCast Server" <<'SH'
#!/bin/bash
RES="$(cd "$(dirname "$0")/../Resources/portalcast" && pwd)"
LABEL="com.portalcast.server"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGDIR="$HOME/Library/Logs/PortalCast"
mkdir -p "$LOGDIR" "$HOME/Library/LaunchAgents"
"$RES/node/bin/node" "$RES/launcher.js" --init-config >/dev/null 2>&1 || true
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$RES/node/bin/node</string><string>$RES/launcher.js</string></array>
  <key>WorkingDirectory</key><string>$RES/app</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/server.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/server.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$AGENT"
for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/ && break; sleep 1; done
FIRST="$HOME/Library/Application Support/PortalCast/FIRST-RUN.txt"
[ -f "$FIRST" ] && [ ! -f "$FIRST.shown" ] && open -e "$FIRST" && touch "$FIRST.shown"
open "http://localhost:3000"
SH
chmod +x "$APP/Contents/MacOS/PortalCast Server"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>PortalCast Server</string>
  <key>CFBundleDisplayName</key><string>PortalCast Server</string>
  <key>CFBundleIdentifier</key><string>com.portalcast.server.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>PortalCast Server</string>
  <key>CFBundleIconFile</key><string>PortalCast.icns</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>
PLIST

ICONSET="$STAGE/PortalCast.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$HERE/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$HERE/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/PortalCast.icns"
rm -rf "$ICONSET"

cat > "$STAGE/READ ME.txt" <<TXT
PortalCast Server $VERSION

1. Drag "PortalCast Server" into Applications.
2. Open it (first time: right-click > Open, the app is not notarized).
   It starts the server, keeps it running at login, and opens http://localhost:3000.
   Admin sign-in: ~/Library/Application Support/PortalCast/FIRST-RUN.txt

Stop and remove the background server:
  launchctl bootout gui/\$(id -u)/com.portalcast.server
  rm ~/Library/LaunchAgents/com.portalcast.server.plist
Optional: brew install ffmpeg (HEVC live / VOD transcoding).
TXT
ln -s /Applications "$STAGE/Applications"

mkdir -p "$OUT"
DMG="$OUT/portalcast-server-$VERSION-macos-$ARCH.dmg"
hdiutil create -volname "PortalCast Server" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "$DMG"
