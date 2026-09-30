#!/usr/bin/env bash
# Sets Holotable up on a Linux server: a Python virtualenv, a .env (from
# .env.example, with a random admin password if you haven't set one), and
# - when run as root with systemd - a "holotable" service that starts on boot.
set -euo pipefail

cd "$(dirname "$0")"
HERE="$(pwd)"

if ! command -v python3 >/dev/null; then
  echo "python3 is needed." >&2
  exit 1
fi

if [ ! -d .venv ]; then
  echo "Making the virtualenv..."
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

if [ ! -f .env ]; then
  cp .env.example .env
  PASS="$(python3 -c 'import secrets; print(secrets.token_urlsafe(12))')"
  sed -i "s|^HT_ADMIN_PASSWORD=.*|HT_ADMIN_PASSWORD=${PASS}|" .env
  echo
  echo "Made .env - first login: admin / ${PASS}"
  echo "(Check GAMEDATA in .env points at your game folder.)"
  echo
fi
chmod 600 .env

if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null; then
  cat > /etc/systemd/system/holotable.service <<EOF
[Unit]
Description=Holotable - MBII scenario builder
After=network.target

[Service]
WorkingDirectory=${HERE}
ExecStart=${HERE}/.venv/bin/python ${HERE}/app.py
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now holotable
  systemctl restart holotable
  echo "Holotable service running - systemctl status holotable"
else
  echo "Run it with: ${HERE}/.venv/bin/python ${HERE}/app.py"
fi
