/**
 * Host and origin helpers for the remote gateway.
 *
 * `advertisedHosts` picks the LAN addresses the phone should try (from the
 * certificate metadata written at startup) and `originAllowed` is the
 * WebSocket upgrade origin check: strict for the LAN-exposed listener, local
 * (same-machine plus `file://`) for the loopback listener only.
 */

import type { IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isIP } from 'node:net'

export function normalizeHostForComparison(host: string): string {
  return host
    .trim()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]
    .toLowerCase()
}

export function lanHostPriority(host: string): number {
  const normalized = normalizeHostForComparison(host)
  if (isIP(normalized) === 4) {
    if (normalized.startsWith('192.168.')) return 0
    if (normalized.startsWith('10.')) return 1
    const secondOctet = Number(normalized.split('.')[1])
    if (normalized.startsWith('172.') && secondOctet >= 16 && secondOctet <= 31) return 2
    return 3
  }
  if (/^(fc|fd)/i.test(normalized)) return 4
  return 5
}

export function usableAdvertisedHost(host: string): boolean {
  const normalized = normalizeHostForComparison(host)
  const family = isIP(normalized)
  if (family === 4) {
    return (
      normalized !== '0.0.0.0' &&
      !normalized.startsWith('127.') &&
      !normalized.startsWith('169.254.')
    )
  }
  if (family === 6) {
    return normalized !== '::' && normalized !== '::1' && !normalized.startsWith('fe80:')
  }
  return false
}

export function hostWithoutPort(hostHeaderValue: string | string[] | undefined): string {
  const value = Array.isArray(hostHeaderValue)
    ? (hostHeaderValue[0] ?? '')
    : (hostHeaderValue ?? '')
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end)
  }
  const lastColon = trimmed.lastIndexOf(':')
  if (lastColon > -1) {
    const candidatePort = trimmed.slice(lastColon + 1)
    if (/^\d+$/.test(candidatePort)) return trimmed.slice(0, lastColon)
  }
  return trimmed
}

/** Advertised LAN hosts, ordered by preference, or `localhost` as fallback. */
export function advertisedHosts(certificateDir: string): string[] {
  try {
    const meta = JSON.parse(readFileSync(join(certificateDir, 'meta.json'), 'utf8')) as {
      hosts?: string[]
      preferredHosts?: string[]
    }
    const advertised =
      Array.isArray(meta.preferredHosts) && meta.preferredHosts.length > 0
        ? meta.preferredHosts
        : meta.hosts
    if (Array.isArray(advertised) && advertised.length > 0) {
      const hosts = advertised
        .map(normalizeHostForComparison)
        .filter(usableAdvertisedHost)
        .sort(
          (left, right) =>
            lanHostPriority(left) - lanHostPriority(right) || left.localeCompare(right)
        )
      if (hosts.length > 0) return [...new Set(hosts)]
    }
  } catch {
    // fall through to localhost
  }
  return ['localhost']
}

/**
 * Origin check for WebSocket upgrades.
 *
 * - `strict` (LAN-exposed HTTPS listener): only same-host origins, plus the
 *   missing/`null` origins produced by non-browser clients.
 * - `local` (loopback-only listener for the desktop's own renderer): also
 *   accepts same-machine origins   `file://` (production renderer loaded via
 *   `loadFile`) and `localhost`/`127.0.0.1`/`::1` (the Vite dev server).
 */
export function originAllowed(
  allowedOrigins: string[] | undefined,
  request: IncomingMessage,
  originPolicy: 'strict' | 'local'
): boolean {
  const origin = request.headers['origin']
  if (!origin || origin === 'null') return true
  try {
    if (allowedOrigins?.includes(new URL(origin).origin)) return true
    // The production renderer is loaded via `loadFile`, so its WebSocket
    // origin is the opaque `file://` (empty host). Only the loopback-only
    // listener may accept it; the LAN-exposed listener stays strict.
    if (originPolicy === 'local' && new URL(origin).protocol === 'file:') return true
    const originHost = normalizeHostForComparison(new URL(origin).hostname)
    if (originPolicy === 'local') {
      if (originHost === 'localhost' || originHost === '127.0.0.1' || originHost === '::1') {
        return true
      }
    }
    const requestHost = normalizeHostForComparison(hostWithoutPort(request.headers.host))
    return originHost === requestHost
  } catch {
    return false
  }
}
