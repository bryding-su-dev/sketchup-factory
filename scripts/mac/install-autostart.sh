#!/usr/bin/env bash
# Register the portal as a LaunchAgent in this user's login session (RunAtLoad + KeepAlive): the macOS counterpart of
# scripts/install-autostart.ps1. It starts the server now and at every login, restarts it when it exits, and writes
# data/server.out.log and data/server.err.log. Run again after moving the checkout or changing node. Idempotent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="${FFSB_LAUNCH_LABEL:-com.sketchup-factory.server}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "node not found on PATH" >&2; exit 1; }
[ -f "${FFSB_CONFIG:-$ROOT/config.json}" ] || { echo "no config at ${FFSB_CONFIG:-$ROOT/config.json}; copy config.example.mac.json to config.json first" >&2; exit 1; }
mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>server/index.ts</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$ROOT/data/server.out.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/server.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$HOME</string>${FFSB_CONFIG:+
    <key>FFSB_CONFIG</key><string>$FFSB_CONFIG</string>}
  </dict>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "installed $LABEL -> $PLIST"
echo "it runs now and at every login; logs: $ROOT/data/server.out.log, $ROOT/data/server.err.log"
