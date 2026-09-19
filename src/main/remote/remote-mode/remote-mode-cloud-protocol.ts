/**
 * Cloud and account wire protocol for remote mode.
 *
 * Pure helpers for the remote-service and account-auth origins, the enrollment
 * and profile response parsers, and the deadline/cancellation-aware fetch used
 * by both the account session and the cloud enrollment poll. Nothing here holds
 * state; the controller and account session own the timers and sockets.
 */

import { isHarnessScopedModelKey } from '../../../lib/model-keys'
import type {
  AccountProfile,
  MemoryEntry,
  MemoryTombstone,
  SyncedDeviceProject,
  SyncedDeviceUsage
} from '../../../lib/types'

declare global {
  /** Public remote-service origin injected by the Electron production build. */
  const __CODEINOVEN_REMOTE_API_ORIGIN__: string | undefined
  /** Public account sign-in origin injected by the Electron production build. */
  const __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__: string | undefined
}
export interface CloudAccessConfig {
  apiOrigin: string
  desktopId: string
  enrollmentId: string
  tokenRef: string
  profileTokenRef?: string
  enrollmentExpiresAt: number
}

export interface AccountSessionConfig {
  apiOrigin: string
  profileTokenRef: string
  expiresAt?: number
}

export interface EnrollmentResponse {
  enrollmentId: string
  desktopId: string
  deviceToken: string | null
  profileToken: string
  code: string
  expiresAt: number
}
export const CLOUD_REQUEST_TIMEOUT_MS = 15_000
export const CLOUD_ENROLLMENT_RETRY_INITIAL_MS = 5_000
/** Storage key for the persisted cloud-access config. */
export const CLOUD_CONFIG_PATH = 'remote/cloud-access.json'
/** Storage key for the persisted account session. */
export const ACCOUNT_CONFIG_PATH = 'account/session.json'
export const CLOUD_ENROLLMENT_RETRY_MAX_MS = 5 * 60_000
export const ACCOUNT_TOKEN_REFRESH_LEAD_MS = 7 * 24 * 60 * 60_000
export const ACCOUNT_TOKEN_REFRESH_RETRY_MS = 5 * 60_000
export const ACCOUNT_TOKEN_REFRESH_TIMER_MAX_MS = 24 * 60 * 60_000
export const ACCOUNT_PROFILE_REFRESH_RETRY_INITIAL_MS = 30_000
export const ACCOUNT_PROFILE_REFRESH_RETRY_MAX_MS = 5 * 60_000
// Every renderer surface that shows the account (sidebar, settings, remote
// client view) calls accountProfile() on mount. The cached profile always
// answers instantly; this bounds how often a mount is additionally allowed to
// revalidate over the network, so opening/switching between those views does
// not each spend a Convex round trip. The periodic scheduleAccountProfileSync
// timer already keeps the cache fresh in the background regardless.
export const ACCOUNT_PROFILE_REFRESH_MIN_INTERVAL_MS = 5 * 60_000
export function cloudResponseIsTerminal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 425 && status !== 429
}

export function cloudRetryAfterMs(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after')
  if (!retryAfter) return null
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const retryAt = Date.parse(retryAfter)
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : null
}

export class CloudRequestCancelledError extends Error {
  constructor() {
    super('Cloud request cancelled')
    this.name = 'CloudRequestCancelledError'
  }
}

export class CloudRequestTimeoutError extends Error {
  constructor() {
    super('Cloud service request timed out')
    this.name = 'CloudRequestTimeoutError'
  }
}

/** Cancellation and deadline timeouts are expected while offline or during teardown. */
export function isExpectedCloudFailure(error: unknown): boolean {
  return error instanceof CloudRequestCancelledError || error instanceof CloudRequestTimeoutError
}

/**
 * Fetch with an application-level deadline and external cancellation. The
 * request aborts when the timeout elapses or the owning controller shuts the
 * cloud access down (remote mode disabled / app dispose), so stale polls can
 * never outlive a config change.
 */
export async function fetchWithDeadline(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal | null
): Promise<Response> {
  const controller = new AbortController()
  const onExternalAbort = (): void => controller.abort()
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (externalSignal?.aborted) throw new CloudRequestCancelledError()
    if (timedOut) throw new CloudRequestTimeoutError()
    throw error
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', onExternalAbort)
  }
}
export function resolveCloudApiOrigin(): string | null {
  const baked =
    typeof __CODEINOVEN_REMOTE_API_ORIGIN__ === 'string'
      ? __CODEINOVEN_REMOTE_API_ORIGIN__
      : undefined
  const value = (process.env['REMOTE_API_ORIGIN'] ?? baked ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function resolveAccountAuthOrigin(): string | null {
  const baked =
    typeof __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__ === 'string'
      ? __CODEINOVEN_ACCOUNT_AUTH_ORIGIN__
      : undefined
  const value = (process.env['ACCOUNT_AUTH_ORIGIN'] ?? baked ?? '').trim()
  if (!value) return null
  try {
    const url = new URL(value)
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function parseEnrollmentResponse(value: unknown): EnrollmentResponse | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    typeof record['enrollmentId'] !== 'string' ||
    typeof record['desktopId'] !== 'string' ||
    (record['deviceToken'] !== null && typeof record['deviceToken'] !== 'string') ||
    typeof record['profileToken'] !== 'string' ||
    typeof record['code'] !== 'string' ||
    typeof record['expiresAt'] !== 'number'
  ) {
    return null
  }
  return {
    enrollmentId: record['enrollmentId'],
    desktopId: record['desktopId'],
    deviceToken: record['deviceToken'] as string | null,
    profileToken: record['profileToken'],
    code: record['code'],
    expiresAt: record['expiresAt']
  }
}

export async function enrollmentFailureMessage(response: Response): Promise<string> {
  let reason = ''
  try {
    const payload: unknown = await response.json()
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const error = (payload as Record<string, unknown>)['error']
      if (typeof error === 'string') reason = error
    }
  } catch {
    // The status code still provides a safe, actionable fallback.
  }
  if (response.status === 401 || reason === 'unauthorized') {
    return 'The remote service could not verify your signed-in account'
  }
  if (response.status === 403 || reason === 'enrollment-conflict') {
    return 'This desktop enrollment belongs to a different account'
  }
  if (response.status === 429 || reason === 'rate-limited') {
    return 'Too many pairing attempts. Wait a moment and try again'
  }
  if (response.status >= 500) return 'The remote pairing service is unavailable'
  return `The remote service rejected pairing (HTTP ${response.status})`
}
export function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function parseSyncedDeviceProject(value: unknown): SyncedDeviceProject | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const messageCount = finiteNumber(row['messageCount'])
  const costUsd = finiteNumber(row['costUsd'])
  const tokens = finiteNumber(row['tokens'])
  const durationMs = finiteNumber(row['durationMs'])
  const threadCount = finiteNumber(row['threadCount'])
  if (
    typeof row['id'] !== 'string' ||
    typeof row['name'] !== 'string' ||
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    threadCount === null
  ) {
    return null
  }
  return {
    id: row['id'],
    name: row['name'],
    messageCount,
    costUsd,
    tokens,
    durationMs,
    threadCount
  }
}

export function parseSyncedDeviceUsage(value: unknown): SyncedDeviceUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const messageCount = finiteNumber(record['messageCount'])
  const costUsd = finiteNumber(record['costUsd'])
  const tokens = finiteNumber(record['tokens'])
  const durationMs = finiteNumber(record['durationMs'])
  const activeDays = finiteNumber(record['activeDays'])
  const updatedAt = finiteNumber(record['updatedAt'])
  if (
    typeof record['deviceId'] !== 'string' ||
    typeof record['deviceLabel'] !== 'string' ||
    typeof record['platform'] !== 'string' ||
    messageCount === null ||
    costUsd === null ||
    tokens === null ||
    durationMs === null ||
    activeDays === null ||
    updatedAt === null ||
    !Array.isArray(record['projects'])
  ) {
    return null
  }
  const projects: SyncedDeviceProject[] = []
  for (const item of record['projects'].slice(0, 10)) {
    const project = parseSyncedDeviceProject(item)
    if (!project) return null
    projects.push(project)
  }
  return {
    deviceId: record['deviceId'],
    deviceLabel: record['deviceLabel'],
    platform: record['platform'],
    messageCount,
    costUsd,
    tokens,
    durationMs,
    activeDays,
    projects,
    updatedAt
  }
}

export function parseUsageByDevice(value: unknown): Record<string, SyncedDeviceUsage> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const byDevice: Record<string, SyncedDeviceUsage> = {}
  for (const [deviceId, raw] of Object.entries(value as Record<string, unknown>)) {
    const usage = parseSyncedDeviceUsage(raw)
    if (!usage || usage.deviceId !== deviceId) return null
    byDevice[deviceId] = usage
  }
  return byDevice
}

export function parseMemoryTombstones(value: unknown): MemoryTombstone[] | null {
  if (!Array.isArray(value)) return null
  const tombstones: MemoryTombstone[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const tombstone = item as Record<string, unknown>
    if (typeof tombstone['id'] !== 'string' || typeof tombstone['deletedAt'] !== 'number') {
      return null
    }
    tombstones.push({ id: tombstone['id'], deletedAt: tombstone['deletedAt'] })
  }
  return tombstones
}

export function parseGlobalMemories(value: unknown): MemoryEntry[] | null {
  if (!Array.isArray(value)) return null
  const entries: MemoryEntry[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
    const entry = item as Record<string, unknown>
    const categories: MemoryEntry['category'][] = [
      'behavioral',
      'project-rule',
      'identity',
      'preference',
      'models'
    ]
    const priorities: MemoryEntry['priority'][] = ['critical', 'high', 'medium', 'low']
    const sources: MemoryEntry['source'][] = ['manual', 'auto-detected']
    if (
      typeof entry['id'] !== 'string' ||
      typeof entry['label'] !== 'string' ||
      typeof entry['content'] !== 'string' ||
      typeof entry['enabled'] !== 'boolean' ||
      typeof entry['updatedAt'] !== 'number' ||
      (entry['createdAt'] !== undefined && typeof entry['createdAt'] !== 'number') ||
      !categories.includes(entry['category'] as MemoryEntry['category']) ||
      !priorities.includes(entry['priority'] as MemoryEntry['priority']) ||
      entry['scope'] !== 'global' ||
      !sources.includes(entry['source'] as MemoryEntry['source']) ||
      typeof entry['frequency'] !== 'number' ||
      typeof entry['lastReinforced'] !== 'number' ||
      (entry['category'] === 'models' &&
        (!Array.isArray(entry['modelKeys']) ||
          entry['modelKeys'].length === 0 ||
          entry['modelKeys'].some(
            (key) => typeof key !== 'string' || !isHarnessScopedModelKey(key)
          )))
    ) {
      return null
    }
    entries.push({
      id: entry['id'],
      label: entry['label'],
      content: entry['content'],
      enabled: entry['enabled'],
      // Older synced payloads predate createdAt; fall back to updatedAt.
      createdAt: typeof entry['createdAt'] === 'number' ? entry['createdAt'] : entry['updatedAt'],
      updatedAt: entry['updatedAt'],
      category: entry['category'] as MemoryEntry['category'],
      priority: entry['priority'] as MemoryEntry['priority'],
      scope: 'global',
      source: entry['source'] as MemoryEntry['source'],
      frequency: entry['frequency'],
      lastReinforced: entry['lastReinforced'],
      ...(Array.isArray(entry['modelKeys']) ? { modelKeys: entry['modelKeys'] as string[] } : {})
    })
  }
  return entries
}

export function parseAccountProfile(value: unknown): AccountProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const wrapper = value as Record<string, unknown>
  const raw = wrapper['profile']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const profile = raw as Record<string, unknown>
  const usageByDevice = parseUsageByDevice(profile['usageByDevice'] ?? {})
  const globalMemories = parseGlobalMemories(profile['globalMemories'])
  const globalMemoryTombstones = parseMemoryTombstones(profile['globalMemoryTombstones'] ?? [])
  if (
    typeof profile['id'] !== 'string' ||
    typeof profile['email'] !== 'string' ||
    typeof profile['displayName'] !== 'string' ||
    (profile['image'] !== null && typeof profile['image'] !== 'string') ||
    typeof profile['updatedAt'] !== 'number' ||
    !usageByDevice ||
    !globalMemories ||
    !globalMemoryTombstones
  ) {
    return null
  }
  return {
    id: profile['id'],
    email: profile['email'],
    displayName: profile['displayName'],
    image: profile['image'],
    usageByDevice,
    globalMemories,
    globalMemoryTombstones,
    updatedAt: profile['updatedAt']
  }
}
