#!/usr/bin/env bash
# Stop the server and remove its LaunchAgent. The checkout, config and data folder stay.
set -euo pipefail
LABEL="${FFSB_LAUNCH_LABEL:-com.sketchup-factory.server}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "removed $LABEL"
