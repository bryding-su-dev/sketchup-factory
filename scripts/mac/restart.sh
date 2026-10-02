#!/usr/bin/env bash
# Restart the LaunchAgent-run server (scripts/mac/install-autostart.sh). Agents mid-turn are cut off and resume on
# their next message, as after any restart; Unity editors are not involved on a Mac host.
set -euo pipefail
LABEL="${FFSB_LAUNCH_LABEL:-com.sketchup-factory.server}"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "restarted $LABEL"
