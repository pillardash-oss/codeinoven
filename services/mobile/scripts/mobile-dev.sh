#!/usr/bin/env bash
# Run the phone against a live service, end to end, in one command.
#
#   bun run dev:android                 # backend + emulator + build + install + launch
#   bun run dev:android -- --seed       # seed the demo account and content first
#   bun run dev:android -- --port 8090  # move both ends to another port
#   bun run dev:android -- --backend-only
#
# The service is built once, started under this script, waited for, and stopped
# when the script leaves. The Android side is the existing emulator script, so
# there is one build path and one place that knows the API origin.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."
MOBILE_DIR="$PWD"
REPO_ROOT="$(cd ../.. && pwd)"
BACKEND_DIR="$REPO_ROOT/services/backend"
SCRATCH="$REPO_ROOT/.cio/tmp/mobile-dev"
mkdir -p "$SCRATCH"

API_BASE="http://10.0.2.2:8081"
PORT=""
AVD="cio_mobile"
DB_NAME="${DATABASE_NAME:-codeinoven_mobile_dev}"
BUILD=true
INSTALL=true
SEED=false

usage() {
  sed -n '2,8p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api) API_BASE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --avd) AVD="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --seed) SEED=true; shift ;;
    --no-build) BUILD=false; shift ;;
    --backend-only) INSTALL=false; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [ -n "$PORT" ]; then
  API_BASE="http://10.0.2.2:$PORT"
fi

HOST_PORT="$(printf '%s' "$API_BASE" | sed -E 's#^https?://[^:/]+:([0-9]+).*#\1#')"
if [ -z "$HOST_PORT" ] || [ "$HOST_PORT" = "$API_BASE" ]; then
  HOST_PORT=80
fi
HTTP_ADDR="127.0.0.1:$HOST_PORT"

# The app and the service must be the only pair on this port: the emulator reaches
# the host loopback through 10.0.2.2, and a second listener there answers some
# requests and drops the rest, which looks like a broken app.
if lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $HOST_PORT is already in use:" >&2
  lsof -nP -iTCP:"$HOST_PORT" -sTCP:LISTEN | sed -n '1,4p' >&2
  echo "stop that process, or run both ends elsewhere:  --port 8090" >&2
  exit 1
fi

if ! command -v go >/dev/null 2>&1; then
  echo "go not found: install the Go toolchain to run the service" >&2
  exit 1
fi

echo "database   $DB_NAME"
bash "$BACKEND_DIR/scripts/db-setup.sh" "$DB_NAME" >/dev/null

EXPORT_DB="DATABASE_URL=postgres://localhost:5432/$DB_NAME?sslmode=disable"

if [ "$SEED" = true ]; then
  echo "seeding     demo account and content"
  (cd "$BACKEND_DIR" && env "$EXPORT_DB" SEED_PASSWORD="${SEED_PASSWORD:-oven-mobile-demo-pass}" go run ./cmd/seed)
fi

echo "building    the service"
(cd "$BACKEND_DIR" && go build -o "$SCRATCH/server" ./cmd/server)

: > "$SCRATCH/backend.log"

cleanup() {
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "starting    http://$HTTP_ADDR"
env "$EXPORT_DB" \
  HTTP_ADDR="$HTTP_ADDR" \
  PUBLIC_BASE_URL="http://localhost:$HOST_PORT" \
  SESSION_SECRET="${SESSION_SECRET:-development-only-session-secret}" \
  ENVIRONMENT="${ENVIRONMENT:-development}" \
  APP_ORIGINS="${APP_ORIGINS:-http://127.0.0.1:5174}" \
  "$SCRATCH/server" >> "$SCRATCH/backend.log" 2>&1 &
BACKEND_PID=$!

READY=false
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$HOST_PORT/v1/auth/providers" >/dev/null 2>&1; then
    READY=true
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if [ "$READY" != true ]; then
  echo "the service did not answer on port $HOST_PORT:" >&2
  tail -n 20 "$SCRATCH/backend.log" >&2
  exit 1
fi

if [ "$INSTALL" = true ]; then
  echo "building    the app against $API_BASE"
  if [ "$BUILD" = true ]; then
    bash scripts/android-emulator-dev.sh --avd "$AVD" --api "$API_BASE"
  else
    bash scripts/android-emulator-dev.sh --avd "$AVD" --api "$API_BASE" --no-build
  fi
else
  echo "skipping    the emulator and the app (--backend-only)"
fi

echo
echo "service     http://127.0.0.1:$HOST_PORT"
echo "app         talks to $API_BASE"
echo "log         $SCRATCH/backend.log"
echo "Ctrl+C stops the service."
tail -n 5 "$SCRATCH/backend.log"
# Wait on the service rather than on a tail: a signal then reaches this script and
# its child together, and the exit trap takes the service down with it.
wait "$BACKEND_PID"
