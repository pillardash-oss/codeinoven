import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { APP_SLUG, ORG_SLUG } from '../../src/lib/brand'
import {
  CrossProcessMutex,
  CLAUDE_CREDENTIAL_LOCK_NAME
} from '../../src/main/system/cross-process-mutex'

const temporaryHomes: string[] = []

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'codeinoven-mutex-home-'))
  temporaryHomes.push(home)
  process.env.HOME = home
  await mkdir(join(home, '.config', ORG_SLUG, APP_SLUG), { recursive: true })
})

afterEach(async () => {
  process.env.HOME = '/tmp'
  await Promise.all(
    temporaryHomes.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
})

describe('CrossProcessMutex', () => {
  it('lets two independent instances mutually exclude critical sections', async () => {
    const a = new CrossProcessMutex(CLAUDE_CREDENTIAL_LOCK_NAME)
    const b = new CrossProcessMutex(CLAUDE_CREDENTIAL_LOCK_NAME)

    const entered: string[] = []
    const releaseA = await a.acquire()
    entered.push('A')

    const bEntered = b
      .acquire()
      .then((releaseB) => {
        entered.push('B')
        return releaseB
      })
      .then((releaseB) => releaseB())

    // b must wait until a releases.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(entered).toEqual(['A'])

    releaseA()
    await bEntered
    expect(entered).toEqual(['A', 'B'])
  })

  it('allows re-entry after release without a long wait', async () => {
    const a = new CrossProcessMutex(CLAUDE_CREDENTIAL_LOCK_NAME)
    const release = await a.acquire()
    release()
    const releaseAgain = await a.acquire()
    releaseAgain()
  })

  it('breaks a stale lock owned by a dead process', async () => {
    // Hand-craft a lock directory owned by a non-existent process and past its
    // staleness bound so `acquire` can overtake it immediately.
    const { existsSync } = await import('node:fs')
    const { writeFile } = await import('node:fs/promises')
    const dir = join(
      process.env.HOME ?? '',
      '.config',
      ORG_SLUG,
      APP_SLUG,
      'locks',
      CLAUDE_CREDENTIAL_LOCK_NAME
    )
    await mkdir(dir, { recursive: true })
    const nearlyDead = 999_999_999
    await writeFile(
      join(dir, 'owner.json'),
      JSON.stringify({ pid: nearlyDead, startedAt: Date.now() - 1_000_000 })
    )

    const mutex = new CrossProcessMutex(CLAUDE_CREDENTIAL_LOCK_NAME)
    const release = await mutex.acquire()
    expect(existsSync(dir)).toBe(true)
    release()
    expect(existsSync(dir)).toBe(false)
  })
})
