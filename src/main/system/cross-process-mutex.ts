import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from './logger'

/**
 * How long a credential-refresh window may legitimately hold the lock. The
 * in-process auth gate already bounds a first-party spawn's refresh at
 * AUTH_CONFIRM_TIMEOUT_MS (~60s), so a lock held at or beyond this mark with a
 * live owner is mis-serialized and must be broken to avoid stalling every other
 * instance or process indefinitely.
 */
const STALE_AFTER_MS = 90_000
/** Poll interval while waiting for another process to release the lock. */
const POLL_INTERVAL_MS = 100
/** Bounded wait before force-breaking a lock that never releases. */
const ACQUIRE_TIMEOUT_MS = 120_000

interface LockOwner {
  pid: number
  startedAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createLockDirPath(name: string): string {
  return join(getConfigRoot(), 'locks', name)
}

/**
 * A cross-process mutual-exclusion lock built on atomic directory creation
 * (`mkdir`). Only one process can own the directory at a time, so any CodeInOven
 * instance — or any code sharing the same config root — can serialize against a
 * shared resource without coordinating in memory.
 *
 * This exists to close a gap the in-process auth gate cannot cover: two app
 * instances each hold their own in-memory gate, so their claude spawns can still
 * race a single-use keychain token and the loser wipes the shared credential
 * (anthropics/claude-code#76905 daily re-login). An atomic lock file is shared
 * across every instance and even across an externally-launched CLI.
 *
 * Stale locks (owner process gone, or held far past a normal refresh window) are
 * broken so a crashed process can never permanently wedge the gate.
 */
export class CrossProcessMutex {
  private readonly dir: string

  constructor(name: string) {
    this.dir = createLockDirPath(name)
    try {
      mkdirSync(dirname(this.dir), { recursive: true })
    } catch {
      // Parent creation is best-effort; acquire reports failures clearly.
    }
  }

  /**
   * Acquire the lock, waiting for any other holder to release first. Resolves
   * to a release function. The callers runs inside the critical section until
   * it calls release; the lock is never re-entrant.
   */
  async acquire(): Promise<() => void> {
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
    for (;;) {
      if (this.tryAcquireAtomically()) return this.makeRelease()
      const now = Date.now()
      if (this.isStale()) {
        this.breakStale()
        continue
      }
      if (now > deadline) {
        Logger.info('Cross-process lock timed out; overtaking a held lock', {
          lock: this.dir,
          elapsedMs: now - (deadline - ACQUIRE_TIMEOUT_MS)
        })
        try {
          rmSync(this.dir, { recursive: true, force: true })
        } catch {
          // Best effort — another process may have cleared it already.
        }
        continue
      }
      await sleep(POLL_INTERVAL_MS)
    }
  }

  private makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        rmSync(this.dir, { recursive: true, force: true })
      } catch {
        // Best effort — the lock may already be gone.
      }
    }
  }

  private tryAcquireAtomically(): boolean {
    try {
      mkdirSync(this.dir, { recursive: false })
      try {
        const owner: LockOwner = { pid: process.pid, startedAt: Date.now() }
        writeFileSync(join(this.dir, 'owner.json'), JSON.stringify(owner))
      } catch {
        // A failure to stamp the owner is non-fatal; the atomically-created
        // directory is still a valid exclusive lock.
      }
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      // An unrelated error (permissions, missing parent) must not let us win a
      // lock we cannot safely own, so treat it as "held" and let the caller
      // wait; a persistent failure surfaces as an acquire-timeout overtake.
      Logger.error('Cross-process lock could not be created', {
        lock: this.dir,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }

  private ownerFile(): string {
    return join(this.dir, 'owner.json')
  }

  private isStale(): boolean {
    const ownerPath = this.ownerFile()
    if (!existsSync(ownerPath)) return false
    try {
      const raw = readFileSync(ownerPath, 'utf8')
      const owner = JSON.parse(raw) as Partial<LockOwner>
      if (typeof owner.pid !== 'number' || typeof owner.startedAt !== 'number') return false
      const ownerAlive = this.isProcessAlive(owner.pid)
      if (!ownerAlive) return true
      return Date.now() - owner.startedAt > STALE_AFTER_MS
    } catch {
      // Unparseable owner with a live holder is not presumed stale.
      return false
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'EPERM'
    }
  }

  private breakStale(): void {
    try {
      const stat = lstatSync(this.dir)
      if (stat.isDirectory()) rmSync(this.dir, { recursive: true, force: true })
    } catch {
      // Directory already gone.
    }
  }
}

/** Convenience path used by the Claude credential gate. */
export const CLAUDE_CREDENTIAL_LOCK_NAME = 'claude-credential-refresh'
