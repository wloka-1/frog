#!/bin/zsh
# launchd entrypoint. Rebuilds node-pty if Homebrew upgraded node under us.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export LANG="${LANG:-en_US.UTF-8}"
# Use the node that ran the installer (nvm/volta nodes aren't on launchd's PATH).
[ -n "$FROG_NODE" ] && export PATH="$(dirname "$FROG_NODE"):$PATH"
cd "$(dirname "$0")/.."
if ! node -e 'require("node-pty")' 2>/dev/null; then
  npm rebuild node-pty >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1
  chmod +x node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null
fi
exec node server/index.js
