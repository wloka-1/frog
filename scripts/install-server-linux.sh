#!/bin/sh
# Install frog as a systemd user service on Linux.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.frog"
cat > "$HOME/.config/systemd/user/frog.service" <<UNIT
[Unit]
Description=frog terminal server
[Service]
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server/index.js
Restart=always
RestartSec=3
Environment=LANG=en_US.UTF-8
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now frog.service
loginctl enable-linger "$USER" 2>/dev/null || true
echo "frog server installed (systemctl --user status frog)"
