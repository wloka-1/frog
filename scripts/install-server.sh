#!/bin/zsh
# Install frog as a login agent on this Mac (starts at login, restarts on crash).
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
PLIST="$HOME/Library/LaunchAgents/dev.frog.server.plist"
mkdir -p "$HOME/.frog" "$HOME/Library/LaunchAgents"
[ -f "$HOME/.frog/config.json" ] || echo '{ "allowedLogins": [] }' > "$HOME/.frog/config.json"
chmod +x "$DIR/scripts/run-server.sh" "$DIR/bin/frog"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.frog.server</string>
  <key>ProgramArguments</key><array><string>$DIR/scripts/run-server.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>3</integer>
  <key>StandardOutPath</key><string>$HOME/.frog/server.log</string>
  <key>StandardErrorPath</key><string>$HOME/.frog/server.log</string>
  <key>EnvironmentVariables</key><dict><key>LANG</key><string>en_US.UTF-8</string><key>FROG_NODE</key><string>$NODE</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/dev.frog.server" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "frog server installed: $PLIST"
