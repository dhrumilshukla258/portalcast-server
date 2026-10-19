#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then systemctl daemon-reload || true; fi
# Config and data (/etc/portalcast, /var/lib/portalcast) are kept; remove them by hand
# for a clean slate. `apt purge` removes them too:
if [ "$1" = "purge" ]; then rm -rf /etc/portalcast /var/lib/portalcast; fi
