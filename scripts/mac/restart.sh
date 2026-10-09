#!/usr/bin/env bash
# Restart SketchUp Factory on macOS (the LaunchAgent from scripts/mac/install-autostart.sh), optionally updating it first:
#   scripts/mac/restart.sh                 drain busy agents (up to 10 min), restart, resume them
#   scripts/mac/restart.sh --update        same, and pull + npm ci + rebuild the web UI before starting again; a build or
#                                          health-check failure rolls back to the previous commit (docs/restart.md)
#   scripts/mac/restart.sh --no-drain      restart at once; agents cut off mid-turn are still resumed afterwards
#   scripts/mac/restart.sh --drain-minutes 3
# The running server does the drain and the clean stop (data/restart.request); the supervisor starts it again.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="${FFSB_LAUNCH_LABEL:-com.sketchup-factory.server}"
UPDATE=false DRAIN='"auto"' MINUTES=10
while [ $# -gt 0 ]; do
  case "$1" in
    --update) UPDATE=true ;;
    --no-drain) DRAIN=false ;;
    --drain-minutes) MINUTES="$2"; shift ;;
    *) echo "unknown option $1 (see the top of $0)" >&2; exit 2 ;;
  esac
  shift
done
DATA="$(cd "$ROOT" && node --input-type=module -e 'import { appPaths } from "./scripts/supervisor.ts"; process.stdout.write(appPaths(process.cwd()).dataDir)' 2>/dev/null || echo "$ROOT/data")"
SUP="$(cat "$DATA/supervisor.pid" 2>/dev/null || true)"
if [ -n "$SUP" ] && ps -o command= -p "$SUP" 2>/dev/null | grep -q 'scripts/supervise.ts'; then
  REASON=$([ "$UPDATE" = true ] && echo 'update (restart.sh --update)' || echo 'restart (restart.sh)')
  printf '{"drain":%s,"drainMinutes":%s,"reason":"%s","update":%s,"hold":false}' "$DRAIN" "$MINUTES" "$REASON" "$UPDATE" > "$DATA/restart.request"
  echo "asked the server to $REASON; progress in $DATA/supervisor.log"
else
  # No supervisor yet (a LaunchAgent from before it): restart the job; an update then has to be done by hand.
  [ "$UPDATE" = true ] && { echo "no supervisor is running (reinstall the LaunchAgent: scripts/mac/install-autostart.sh); update by hand: git pull --ff-only && npm ci && npm run build" >&2; exit 1; }
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
  echo "restarted $LABEL"
fi
