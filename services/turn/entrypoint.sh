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

require_positive_integer() {
  name="$1"
  value="$2"

  case "$value" in
    ''|*[!0-9]*) fail "$name must be a positive integer" ;;
  esac

  [ "$value" -gt 0 ] || fail "$name must be a positive integer"
}

turn_shared_secret="${TURN_SHARED_SECRET:-}"
turn_realm="${TURN_REALM:-turn.codeinoven.com}"
turn_port="${TURN_PORT:-3478}"
turn_min_port="${TURN_MIN_PORT:-49160}"
turn_max_port="${TURN_MAX_PORT:-49200}"
turn_external_ip="${TURN_EXTERNAL_IP:-auto}"
turn_relay_ip="${TURN_RELAY_IP:-}"
turn_unauthorized_ratelimit_rps="${TURN_UNAUTHORIZED_RATELIMIT_RPS:-10}"
turn_user_quota="${TURN_USER_QUOTA:-4}"
turn_total_quota="${TURN_TOTAL_QUOTA:-40}"
turn_max_bps="${TURN_MAX_BPS:-2000000}"
turn_bps_capacity="${TURN_BPS_CAPACITY:-50000000}"
turn_max_allocate_timeout="${TURN_MAX_ALLOCATE_TIMEOUT:-10}"

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

require_positive_integer 'TURN_UNAUTHORIZED_RATELIMIT_RPS' "$turn_unauthorized_ratelimit_rps"
require_positive_integer 'TURN_USER_QUOTA' "$turn_user_quota"
require_positive_integer 'TURN_TOTAL_QUOTA' "$turn_total_quota"
require_positive_integer 'TURN_MAX_BPS' "$turn_max_bps"
require_positive_integer 'TURN_BPS_CAPACITY' "$turn_bps_capacity"
require_positive_integer 'TURN_MAX_ALLOCATE_TIMEOUT' "$turn_max_allocate_timeout"

[ "$turn_user_quota" -le "$turn_total_quota" ] ||
  fail 'TURN_USER_QUOTA must be less than or equal to TURN_TOTAL_QUOTA'
[ "$turn_max_bps" -le "$turn_bps_capacity" ] ||
  fail 'TURN_MAX_BPS must be less than or equal to TURN_BPS_CAPACITY'
[ "$turn_max_allocate_timeout" -le 60 ] ||
  fail 'TURN_MAX_ALLOCATE_TIMEOUT must be between 1 and 60 seconds'

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
  if [ -n "$turn_relay_ip" ]; then
    printf '%s\n' 'listening-ip=127.0.0.1'
    printf 'listening-ip=%s\n' "$turn_relay_ip"
    printf 'relay-ip=%s\n' "$turn_relay_ip"
  fi
  printf 'realm=%s\n' "$turn_realm"
  printf 'server-name=%s\n' "$turn_realm"
  printf 'static-auth-secret=%s\n' "$turn_shared_secret"
  printf 'unauthorized-ratelimit-rps=%s\n' "$turn_unauthorized_ratelimit_rps"
  printf 'user-quota=%s\n' "$turn_user_quota"
  printf 'total-quota=%s\n' "$turn_total_quota"
  printf 'max-bps=%s\n' "$turn_max_bps"
  printf 'bps-capacity=%s\n' "$turn_bps_capacity"
  printf 'max-allocate-timeout=%s\n' "$turn_max_allocate_timeout"
  printf '%s\n' \
    'fingerprint' \
    'use-auth-secret' \
    'unauthorized-ratelimit' \
    'stale-nonce=600' \
    'max-allocate-lifetime=3600' \
    'no-auth-pings' \
    'no-dynamic-ip-list' \
    'no-dynamic-realms' \
    'no-multicast-peers' \
    'no-tcp-relay' \
    'no-tls' \
    'no-software-attribute' \
    'pidfile=/tmp/turnserver.pid' \
    'simple-log' \
    'log-file=stdout' \
    'denied-peer-ip=0.0.0.0-0.255.255.255' \
    'denied-peer-ip=10.0.0.0-10.255.255.255' \
    'denied-peer-ip=100.64.0.0-100.127.255.255' \
    'denied-peer-ip=127.0.0.0-127.255.255.255' \
    'denied-peer-ip=169.254.0.0-169.254.255.255' \
    'denied-peer-ip=172.16.0.0-172.31.255.255' \
    'denied-peer-ip=192.0.0.0-192.0.0.255' \
    'denied-peer-ip=192.168.0.0-192.168.255.255' \
    'denied-peer-ip=198.18.0.0-198.19.255.255' \
    'denied-peer-ip=224.0.0.0-255.255.255.255'
} > "$config_path"

exec turnserver -c "$config_path"
