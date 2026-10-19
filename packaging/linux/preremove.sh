#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl stop portalcast.service >/dev/null 2>&1 || true
  # Keep it enabled on upgrade; disable only on removal.
  if [ "$1" = "remove" ] || [ "$1" = "0" ]; then systemctl disable portalcast.service >/dev/null 2>&1 || true; fi
fi
