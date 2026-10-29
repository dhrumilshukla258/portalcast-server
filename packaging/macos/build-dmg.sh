#!/bin/bash
# Build "PortalCast Server.app" around a bundle from build-bundle.mjs and wrap it in a .dmg.
#   packaging/macos/build-dmg.sh <bundle dir> <version> <arch: arm64|x64> <out dir>
# Runs on macOS (hdiutil, iconutil, sips).
#
# The app (PortalCastServer.swift, compiled here) shows the server's log and status with
# Start/Stop and a menu-bar item. The server runs as a per-user LaunchAgent
# (~/Library/LaunchAgents/com.portalcast.server.plist: start at login, restart if it stops),
# so it keeps running with the window closed. Opening the app the first time starts it.
# Config + data: ~/Library/Application Support/PortalCast. Log: ~/Library/Logs/PortalCast.
set -euo pipefail
BUNDLE="$1"; VERSION="$2"; ARCH="$3"; OUT="$4"
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE="$(mktemp -d)"
APP="$STAGE/PortalCast Server.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp -R "$BUNDLE" "$APP/Contents/Resources/portalcast"

# The app: a window with the log, Start/Stop and a menu-bar item (PortalCastServer.swift).
swiftc -O -o "$APP/Contents/MacOS/PortalCast Server" "$HERE/PortalCastServer.swift" -framework AppKit

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
   It starts the server (and keeps it running at login) and shows its log, with
   Open PortalCast, Start, Stop and Restart. Closing the window leaves the server
   running; the menu-bar item brings it back.
   Admin sign-in: ~/Library/Application Support/PortalCast/FIRST-RUN.txt

Stop the server (it then stays off at login too): Stop in the app.
Optional: brew install ffmpeg (HEVC live / VOD transcoding).
TXT
ln -s /Applications "$STAGE/Applications"

mkdir -p "$OUT"
DMG="$OUT/portalcast-server-$VERSION-macos-$ARCH.dmg"
hdiutil create -volname "PortalCast Server" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
echo "$DMG"
