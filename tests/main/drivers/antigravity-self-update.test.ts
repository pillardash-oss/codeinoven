import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antigravityAutoUpdateStampPath,
  holdAntigravitySelfUpdate
} from '../../../src/main/drivers/antigravity/antigravity-self-update'

const roots: string[] = []

async function tempHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-agy-update-'))
  roots.push(root)
  return root
}

async function profileHome(): Promise<string> {
  const home = await tempHome()
  await mkdir(join(home, '.gemini', 'antigravity-cli'), { recursive: true })
  return home
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('antigravity self-update hold', () => {
  it('resolves the stamp under the home the CLI runs with', async () => {
    expect(antigravityAutoUpdateStampPath({ HOME: '/tmp/account-home' })).toBe(
      '/tmp/account-home/.gemini/antigravity-cli/last_check.timestamp'
    )
    expect(antigravityAutoUpdateStampPath({ USERPROFILE: 'C:\\Users\\me' })).toContain(
      join('.gemini', 'antigravity-cli', 'last_check.timestamp')
    )
  })

  it('creates the stamp for an install that has a profile directory', async () => {
    const home = await profileHome()
    const stamp = antigravityAutoUpdateStampPath({ HOME: home })
    expect(existsSync(stamp)).toBe(false)

    await holdAntigravitySelfUpdate({ HOME: home })

    expect(existsSync(stamp)).toBe(true)
    const info = await stat(stamp)
    expect(Math.abs(Date.now() - info.mtimeMs)).toBeLessThan(10_000)
  })

  it('refreshes a stale stamp so the CLI takes its throttled path', async () => {
    const home = await profileHome()
    const stamp = antigravityAutoUpdateStampPath({ HOME: home })
    await writeFile(stamp, '')
    const stale = new Date(Date.now() - 6 * 60 * 60_000)
    await utimes(stamp, stale, stale)

    await holdAntigravitySelfUpdate({ HOME: home })

    const info = await stat(stamp)
    expect(info.mtimeMs).toBeGreaterThan(stale.getTime() + 60 * 60_000)
    expect(Math.abs(Date.now() - info.mtimeMs)).toBeLessThan(10_000)
  })

  it('leaves a home with no Antigravity profile untouched', async () => {
    const home = await tempHome()

    await holdAntigravitySelfUpdate({ HOME: home })

    expect(existsSync(join(home, '.gemini', 'antigravity-cli'))).toBe(false)
  })

  it('never throws when the stamp cannot be written', async () => {
    const home = await profileHome()
    // A directory where the stamp file belongs leaves nothing to stamp, and a
    // filesystem failure must never surface as a failed launch.
    await mkdir(antigravityAutoUpdateStampPath({ HOME: home }), { recursive: true })

    await expect(holdAntigravitySelfUpdate({ HOME: home })).resolves.toBeUndefined()
  })

  it('holds the install of a managed account HOME container', async () => {
    const container = await tempHome()
    await mkdir(join(container, '.gemini', 'antigravity-cli'), { recursive: true })

    await holdAntigravitySelfUpdate({ HOME: container })

    expect(existsSync(antigravityAutoUpdateStampPath({ HOME: container }))).toBe(true)
  })
})
