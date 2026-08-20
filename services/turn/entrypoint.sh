#!/bin/sh
set -eu

fail() {
  printf 'TURN configuration error: %s\n' "$1" >&2
  exit 1
}

require_port() {
  name="$1"
  value="$2"

  case "$value" in
    ''|*[!0-9]*) fail "$name must be an integer between 1 and 65535" ;;
  esac

  [ "$value" -ge 1 ] && [ "$value" -le 65535 ] ||
    fail "$name must be an integer between 1 and 65535"
}

turn_shared_secret="${TURN_SHARED_SECRET:-}"
turn_realm="${TURN_REALM:-turn.codeinoven.com}"
turn_port="${TURN_PORT:-3478}"
turn_min_port="${TURN_MIN_PORT:-49160}"
turn_max_port="${TURN_MAX_PORT:-49200}"
turn_external_ip="${TURN_EXTERNAL_IP:-auto}"
turn_relay_ip="${TURN_RELAY_IP:-}"

[ "${#turn_shared_secret}" -ge 32 ] ||
  fail 'TURN_SHARED_SECRET is required and must contain at least 32 characters'
case "$turn_shared_secret" in
  *[!A-Za-z0-9_+/=-]*)
    fail 'TURN_SHARED_SECRET must use base64-safe characters only'
    ;;
esac

case "$turn_realm" in
  ''|*[!A-Za-z0-9.-]*) fail 'TURN_REALM must be a DNS name' ;;
esac

require_port 'TURN_PORT' "$turn_port"
require_port 'TURN_MIN_PORT' "$turn_min_port"
require_port 'TURN_MAX_PORT' "$turn_max_port"
[ "$turn_min_port" -le "$turn_max_port" ] ||
  fail 'TURN_MIN_PORT must be less than or equal to TURN_MAX_PORT'

if [ "$turn_external_ip" = 'auto' ]; then
  turn_external_ip="$(detect-external-ip)"
fi

case "$turn_external_ip" in
  ''|*[!0-9A-Fa-f:.]*) fail 'TURN_EXTERNAL_IP must be auto or a public IPv4/IPv6 address' ;;
esac

if [ -n "$turn_relay_ip" ]; then
  case "$turn_relay_ip" in
    *[!0-9A-Fa-f:.]*) fail 'TURN_RELAY_IP must be an IPv4/IPv6 address' ;;
  esac
  turn_external_mapping="${turn_external_ip}/${turn_relay_ip}"
else
  turn_external_mapping="$turn_external_ip"
fi

config_path='/tmp/codeinoven-turnserver.conf'
umask 077
{
  printf 'listening-port=%s\n' "$turn_port"
  printf 'min-port=%s\n' "$turn_min_port"
  printf 'max-port=%s\n' "$turn_max_port"
  printf 'external-ip=%s\n' "$turn_external_mapping"
  printf 'realm=%s\n' "$turn_realm"
  printf 'server-name=%s\n' "$turn_realm"
  printf 'static-auth-secret=%s\n' "$turn_shared_secret"
  printf '%s\n' \
    'fingerprint' \
    'use-auth-secret' \
    'stale-nonce=600' \
    'max-allocate-lifetime=3600' \
    'no-cli' \
    'no-multicast-peers' \
    'no-tls' \
    'no-dtls' \
    'no-software-attribute' \
    'simple-log' \
    'log-file=stdout'
} > "$config_path"

exec turnserver -c "$config_path"
