#!/usr/bin/env bash
# The phone's service, alone, in this terminal so its log is this log.
#
#   bun run dev:backend                  # 127.0.0.1:8081 against the mobile database
#   bun run dev:backend -- --seed        # seed the demo account and content first
#   bun run dev:backend -- --port 8090   # a different port (and the app's build too)
#
# The app reaches the host through the emulator's 10.0.2.2 alias, so the service
# listens on the host loopback only. It runs in the foreground: Ctrl+C stops it and
# the terminal keeps the whole log.
set -euo pipefail

SCRIPT_PATH="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")/.."
REPO_ROOT="$(cd ../.. && pwd)"
BACKEND_DIR="$REPO_ROOT/services/backend"
SCRATCH="$REPO_ROOT/.cio/tmp/mobile-dev"
mkdir -p "$SCRATCH"

PORT=8081
DB_NAME="${DATABASE_NAME:-codeinoven_mobile_dev}"
SEED=false

usage() {
  sed -n '2,8p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --db) DB_NAME="$2"; shift 2 ;;
    --seed) SEED=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port $PORT is already in use:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN | sed -n '1,4p' >&2
  echo "stop that process, or run with --port 8090" >&2
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

echo "starting    http://127.0.0.1:$PORT   (the phone reaches it at 10.0.2.2:$PORT)"
exec env "$EXPORT_DB" \
  HTTP_ADDR="127.0.0.1:$PORT" \
  PUBLIC_BASE_URL="http://localhost:$PORT" \
  SESSION_SECRET="${SESSION_SECRET:-development-only-session-secret}" \
  ENVIRONMENT="${ENVIRONMENT:-development}" \
  APP_ORIGINS="${APP_ORIGINS:-http://127.0.0.1:5174}" \
  "$SCRATCH/server"
