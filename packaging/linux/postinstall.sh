#!/bin/sh
set -e
if ! getent group portalcast >/dev/null; then groupadd --system portalcast; fi
if ! getent passwd portalcast >/dev/null; then
  useradd --system --gid portalcast --home-dir /var/lib/portalcast --no-create-home --shell /usr/sbin/nologin portalcast
fi
mkdir -p /var/lib/portalcast /etc/portalcast
chown portalcast:portalcast /var/lib/portalcast /etc/portalcast
chmod 750 /var/lib/portalcast /etc/portalcast
# Creates /etc/portalcast/portalcast.env (random JWT secret + admin password) on first install only.
su -s /bin/sh portalcast -c "/opt/portalcast/node/bin/node /opt/portalcast/launcher.js --init-config --config /etc/portalcast/portalcast.env --data /var/lib/portalcast" || true
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable portalcast.service >/dev/null 2>&1 || true
  systemctl restart portalcast.service || true
fi
echo ""
echo "PortalCast Server is running on http://localhost:3000"
echo "Admin sign-in: see /etc/portalcast/FIRST-RUN.txt (sudo cat /etc/portalcast/FIRST-RUN.txt)"
echo "Settings: /etc/portalcast/portalcast.env, then: sudo systemctl restart portalcast"
