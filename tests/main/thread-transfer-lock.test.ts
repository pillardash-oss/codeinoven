import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from '../../src/main/database/database'
import {
  ThreadTransferLock,
  TRANSFER_LOCK_TTL_MS
} from '../../src/main/system/thread-transfer-lock'
import { createTestDb, destroyTestDb } from './database/test-helper'

/**
 * The cross-process transfer mutex, exercised against one shared database   the
 * way two instances share the config root   with each claimant given its own
 * pid, so a claim, a refusal, and a take-over are all real.
 */

const PROJECT_ID = 'project1'
const THREAD_ID = 'thread1'
const FIRST_PID = 5_111
const SECOND_PID = 5_222
const DEAD_PID = 5_333

const testDatabases: Database[] = []
let database: Database

beforeEach(async () => {
  database = await createTestDb()
  testDatabases.push(database)
})

afterEach(() => {
  for (const db of testDatabases.splice(0)) destroyTestDb(db)
})

function lockFor(
  localPid: number,
  options: { isRunOwnerAlive?: (pid: number) => boolean; now?: () => number; ttlMs?: number } = {}
): ThreadTransferLock {
  return new ThreadTransferLock(database, {
    localPid,
    isRunOwnerAlive: options.isRunOwnerAlive ?? (() => true),
    now: options.now,
    ttlMs: options.ttlMs
  })
}

describe('ThreadTransferLock', () => {
  it('lets one claimant hold a role and refuses the next', async () => {
    const first = lockFor(FIRST_PID)
    const second = lockFor(SECOND_PID)
    const token = await first.acquire(PROJECT_ID, THREAD_ID, 'adopt')
    expect(token).not.toBeNull()
    await expect(first.holds(PROJECT_ID, THREAD_ID, 'adopt', FIRST_PID, token ?? '')).resolves.toBe(
      true
    )
    await expect(second.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.toBeNull()
    await expect(second.holds(PROJECT_ID, THREAD_ID, 'adopt', SECOND_PID)).resolves.toBe(false)
  })

  it('does not release a claim through a token that is not the one held', async () => {
    const first = lockFor(FIRST_PID)
    const second = lockFor(SECOND_PID)
    const token = await first.acquire(PROJECT_ID, THREAD_ID, 'adopt')
    expect(token).not.toBeNull()

    await first.release(PROJECT_ID, THREAD_ID, 'adopt', 'not-the-token')
    await expect(second.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.toBeNull()

    if (token) await first.release(PROJECT_ID, THREAD_ID, 'adopt', token)
    await expect(second.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.not.toBeNull()
  })

  it('refreshes a claim this process already holds and mints a new token', async () => {
    const first = lockFor(FIRST_PID)
    const firstToken = await first.acquire(PROJECT_ID, THREAD_ID, 'adopt')
    const secondToken = await first.acquire(PROJECT_ID, THREAD_ID, 'adopt')

    expect(firstToken).not.toBeNull()
    expect(secondToken).not.toBeNull()
    expect(secondToken).not.toBe(firstToken)
    await expect(
      first.holds(PROJECT_ID, THREAD_ID, 'adopt', FIRST_PID, secondToken ?? '')
    ).resolves.toBe(true)
    await expect(
      first.holds(PROJECT_ID, THREAD_ID, 'adopt', FIRST_PID, firstToken ?? '')
    ).resolves.toBe(false)
  })

  it('takes over a lease that ran out', async () => {
    let clock = 1_000
    const now = () => clock
    const first = lockFor(FIRST_PID, { now, ttlMs: TRANSFER_LOCK_TTL_MS })
    const second = lockFor(SECOND_PID, { now, ttlMs: TRANSFER_LOCK_TTL_MS })

    await expect(first.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.not.toBeNull()
    expect(await second.acquire(PROJECT_ID, THREAD_ID, 'adopt')).toBeNull()

    clock += TRANSFER_LOCK_TTL_MS + 1
    await expect(second.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.not.toBeNull()
  })

  it('takes over a claim whose holder is gone', async () => {
    const gone = (pid: number) => pid !== DEAD_PID
    const dead = lockFor(DEAD_PID, { isRunOwnerAlive: gone })
    const second = lockFor(SECOND_PID, { isRunOwnerAlive: gone })

    await expect(dead.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.not.toBeNull()
    await expect(second.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.not.toBeNull()
    await expect(second.holds(PROJECT_ID, THREAD_ID, 'adopt', SECOND_PID)).resolves.toBe(true)
  })

  it('keeps the two roles independent', async () => {
    const first = lockFor(FIRST_PID)
    const second = lockFor(SECOND_PID)
    await expect(first.acquire(PROJECT_ID, THREAD_ID, 'adopt')).resolves.not.toBeNull()
    // A release claim is a different row from an adopt claim, so it is not blocked.
    await expect(second.acquire(PROJECT_ID, THREAD_ID, 'release')).resolves.not.toBeNull()
  })
})
