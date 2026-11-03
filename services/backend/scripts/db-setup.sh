#!/usr/bin/env bash
# Create the local development database when it is missing.
#
# Idempotent and password free: it uses whatever libpq defaults are in effect for
# the current user (a local trust/peer socket or PGHOST/PGUSER etc). The server
# applies migrations at startup, so this script only creates the database.
set -euo pipefail

DB_NAME="${1:-${DATABASE_NAME:-codeinoven_dev}}"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found: install Postgres before running this script" >&2
  exit 1
fi

if psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" postgres | grep -q 1; then
  echo "database $DB_NAME already exists"
else
  createdb "$DB_NAME"
  echo "created database $DB_NAME"
fi

echo "DATABASE_URL example: postgres://localhost:5432/$DB_NAME?sslmode=disable"
