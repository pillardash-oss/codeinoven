#!/usr/bin/env bash
# The phone app alone: boot the emulator, build the web bundle against the running
# service, install the APK and launch it, then stay attached to the app's own log
# so the run shows what the app does. The service is not started here, so its log
# stays in its own terminal.
#
#   bun run dev:app                  # against http://10.0.2.2:8081, then follow the log
#   bun run dev:app -- --port 8090   # against a service running on another port
#   bun run dev:app -- --no-build    # reinstall the bundle that is already built
#   bun run dev:app -- --no-follow   # install, launch and return
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."

API_BASE="http://10.0.2.2:8081"
BUILD=true
FOLLOW=true

usage() {
  sed -n '2,10p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_BASE="$2"; shift 2 ;;
    --port) API_BASE="http://10.0.2.2:$2"; shift 2 ;;
    --no-build) BUILD=false; shift ;;
    --no-follow) FOLLOW=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

HOST_PORT="$(printf '%s' "$API_BASE" | sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#')"
if [ -z "$HOST_PORT" ] || [ "$HOST_PORT" = "$API_BASE" ]; then
  HOST_PORT=80
fi

if ! curl -fsS "http://127.0.0.1:$HOST_PORT/v1/auth/providers" >/dev/null 2>&1; then
  echo "warning: nothing answers on 127.0.0.1:$HOST_PORT." >&2
  echo "         start the Backend action first, or the app will open with no data." >&2
fi

emulator_args=(--api "$API_BASE")
if [ "$BUILD" = false ]; then
  emulator_args+=(--no-build)
fi
if [ "$FOLLOW" = true ]; then
  emulator_args+=(--follow)
fi
bash scripts/android-emulator-dev.sh "${emulator_args[@]}"
