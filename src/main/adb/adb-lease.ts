/**
 * The exclusive lease one thread holds over one attached Android target.
 *
 * This is the fix for the most damaging finding in
 * `.cio/work/adb-agent-interaction/FINDINGS.md`: three agent threads were tapping
 * the same 1080x2340 screen at the same time, and one of them force-stopped the
 * app another was reasoning about. Nothing in CodeInOven knew a physical target
 * was busy.
 *
 * The claim is a single atomic `mkdir`, the same primitive
 * `src/main/system/cross-process-mutex.ts` uses, but with lease semantics rather
 * than critical-section semantics: a phone is held for minutes, so nothing here
 * overtakes a live holder. A lease ends three ways, and only these three:
 *
 * 1. the holder releases it,
 * 2. the holder's process exits (`pid` no longer exists),
 * 3. nobody heartbeat it before `expiresAt`.
 *
 * The directory lives beside the app's other locks so an operator can inspect it
 * with `ls`, and two CodeInOven instances sharing one config root cannot both
 * claim the same target.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import type { AdbLease } from './adb-types'

/** Default hold, in minutes, refreshed by every operation the holder runs. */
const DEFAULT_TTL_MINUTES = 15
/** Ceiling on a requested hold, so a typo cannot pin a target for a day. */
const MAX_TTL_MINUTES = 240

/** Directory prefix every target lease uses, so the lock folder stays scannable. */
const LEASE_DIRECTORY_PREFIX = 'adb-target-'

/** The folder the app's cross-process locks live in. */
function lockRoot(): string {
  return join(getConfigRoot(), 'locks')
}

/**
 * Make sure the lock folder exists before an atomic `mkdir` inside it.
 *
 * The atomic create has to run with `recursive: false`, because that is what
 * makes it exclusive, and a non-recursive create fails outright when the parent
 * is missing. A fresh install has no `locks` folder until something needs one, so
 * this must run first or the very first claim fails with ENOENT.
 */
function ensureLockRoot(): void {
  mkdirSync(lockRoot(), { recursive: true })
}

/** Where one target's lease directory lives. */
function leaseDirectory(serial: string): string {
  const safe = serial.replace(/[^A-Za-z0-9._-]/gu, '_')
  return join(getConfigRoot(), 'locks', `${LEASE_DIRECTORY_PREFIX}${safe}`)
}

function leaseFilePath(serial: string): string {
  return join(leaseDirectory(serial), 'lease.json')
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function readLeaseFile(path: string): AdbLease | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AdbLease>
    if (
      typeof parsed.serial !== 'string' ||
      typeof parsed.threadId !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null
    }
    return {
      serial: parsed.serial,
      threadId: parsed.threadId,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : '',
      pid: parsed.pid,
      heldSince: typeof parsed.heldSince === 'number' ? parsed.heldSince : parsed.expiresAt,
      heartbeatAt: typeof parsed.heartbeatAt === 'number' ? parsed.heartbeatAt : parsed.expiresAt,
      expiresAt: parsed.expiresAt
    }
  } catch {
    // A half-written or unreadable lease is treated as absent; the directory
    // itself still blocks a second claim until it is reclaimed below.
    return null
  }
}

function readLease(serial: string): AdbLease | null {
  return readLeaseFile(leaseFilePath(serial))
}

/** Read a lease straight from its directory, which is how a thread finds its own
 *  target without having to reconstruct the serial from the folder name. */
function readLeaseFromDirectory(directory: string): AdbLease | null {
  return readLeaseFile(join(directory, 'lease.json'))
}

function writeLease(lease: AdbLease): void {
  const directory = leaseDirectory(lease.serial)
  mkdirSync(directory, { recursive: true })
  const target = leaseFilePath(lease.serial)
  const temporary = `${target}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(lease, null, 2))
  renameSync(temporary, target)
}

/** True when a lease is over: expired, or its owner's process is gone. */
function leaseIsDead(lease: AdbLease): boolean {
  if (lease.expiresAt <= Date.now()) return true
  return !processIsAlive(lease.pid)
}

function clampTtlMinutes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TTL_MINUTES
  return Math.min(MAX_TTL_MINUTES, Math.max(1, Math.round(value)))
}

/** Human-readable holder description, used in every refusal message. */
export function describeLease(lease: AdbLease): string {
  const heldFor = Math.max(0, Math.round((Date.now() - lease.heldSince) / 1000))
  const expiresIn = Math.max(0, Math.round((lease.expiresAt - Date.now()) / 1000))
  return `thread ${lease.threadId} in process ${lease.pid}, held for ${heldFor}s, expires in ${expiresIn}s`
}

/** The current holder of a target, or `null` when it is free. */
export function readTargetLease(serial: string): AdbLease | null {
  const lease = readLease(serial)
  if (!lease) return null
  return leaseIsDead(lease) ? null : lease
}

/**
 * The live lease one thread holds, if any. A thread holds at most one target, so
 * this is how a driving operation finds the target it is allowed to touch
 * without the caller repeating the serial on every call.
 */
export function findLeaseForThread(threadId: string): AdbLease | null {
  const locksRoot = lockRoot()
  if (!existsSync(locksRoot)) return null
  let entries: string[]
  try {
    entries = readdirSync(locksRoot)
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.startsWith(LEASE_DIRECTORY_PREFIX)) continue
    const directory = join(locksRoot, entry)
    const lease = readLeaseFromDirectory(directory)
    if (!lease || lease.threadId !== threadId) continue
    if (leaseIsDead(lease)) {
      rmSync(directory, { recursive: true, force: true })
      continue
    }
    return lease
  }
  return null
}

export interface ClaimRequest {
  serial: string
  threadId: string
  projectId: string
  ttlMinutes?: number
}

/**
 * Take the target's lease.
 *
 * Re-claiming a lease this thread already holds refreshes it, so an agent that
 * claims twice does not strand its own hold. Any other live lease refuses with
 * the holder named, which is the error the calling agent needs in order to stop
 * rather than tap into someone else's run.
 */
export function claimTarget(request: ClaimRequest): AdbLease {
  const { serial, threadId, projectId } = request
  const ttl = clampTtlMinutes(request.ttlMinutes)
  const directory = leaseDirectory(serial)
  const now = Date.now()
  ensureLockRoot()

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Atomic across processes: only one caller can create the directory.
      mkdirSync(directory, { recursive: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existing = readLease(serial)
      if (existing && existing.threadId === threadId) {
        const refreshed: AdbLease = {
          ...existing,
          heartbeatAt: now,
          expiresAt: now + ttl * 60_000
        }
        writeLease(refreshed)
        return refreshed
      }
      if (!existing || leaseIsDead(existing)) {
        // The directory outlived its lease: reclaim it and try once more.
        rmSync(directory, { recursive: true, force: true })
        continue
      }
      throw new Error(
        `Target ${serial} is already leased by ${describeLease(existing)}. Wait for that session to release it, or work on a different target. Never drive a target you do not hold.`,
        { cause: error }
      )
    }
    const lease: AdbLease = {
      serial,
      threadId,
      projectId,
      pid: process.pid,
      heldSince: now,
      heartbeatAt: now,
      expiresAt: now + ttl * 60_000
    }
    writeLease(lease)
    return lease
  }
  throw new Error(`Target ${serial} could not be leased: another session holds it.`)
}

/** Extend a lease this thread holds. Silently does nothing when it is not ours. */
export function heartbeatTarget(serial: string, threadId: string, ttlMinutes?: number): void {
  const lease = readLease(serial)
  if (!lease || lease.threadId !== threadId) return
  const ttl = clampTtlMinutes(
    ttlMinutes ?? Math.round((lease.expiresAt - lease.heartbeatAt) / 60_000)
  )
  lease.heartbeatAt = Date.now()
  lease.expiresAt = Date.now() + ttl * 60_000
  writeLease(lease)
}

/**
 * Drop a lease.
 *
 * `threadId` is the caller: releasing your own lease is always allowed. Passing
 * no `threadId` force-clears the target, which the reclaim path uses for a lease
 * whose owner is already gone.
 */
export function releaseTarget(serial: string, threadId?: string): boolean {
  const existing = readLease(serial)
  if (existing && threadId !== undefined && existing.threadId !== threadId) {
    throw new Error(
      `Target ${serial} is leased by ${describeLease(existing)}, not by this session. Only the holder can release it.`
    )
  }
  const directory = leaseDirectory(serial)
  if (!existsSync(directory)) return false
  rmSync(directory, { recursive: true, force: true })
  return true
}
