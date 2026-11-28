import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  installTerminalEnvHook,
  type TerminalEnvHookSession
} from '../../../src/main/system/terminal-env-hook'

/**
 * The scratch root for every session in this file.
 *
 * A hook directory holds decrypted values, so it is never left in the OS temp tree:
 * the suite's own folder is removed after each test.
 */
const SCRATCH = join(process.cwd(), '.cio/tmp/env-hook-tests')

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() - started > timeoutMs) throw new Error('The hook never answered')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('installTerminalEnvHook', () => {
  let root: string
  let session: TerminalEnvHookSession | null

  beforeEach(async () => {
    root = join(SCRATCH, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })
    session = null
  })

  afterEach(async () => {
    await session?.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('declines a shell that has no pre-exec point', async () => {
    session = await installTerminalEnvHook({
      sessionId: 'sh',
      shell: '/bin/sh',
      deferred: ['KEY'],
      environment: {},
      resolve: async () => ({}),
      root
    })
    expect(session).toBeNull()
  })

  it('answers a request with the values the resolver admits and names them', async () => {
    session = await installTerminalEnvHook({
      sessionId: 'zsh',
      shell: '/bin/zsh',
      deferred: ['STRIPE_KEY'],
      environment: { APP_NAME: 'Oven' },
      resolve: async ({ command, pwd }) =>
        command === 'bun run deploy' && pwd === '/repo'
          ? { STRIPE_KEY: "sk_live_1'" }
          : ({} as Record<string, string>),
      root
    })
    expect(session).not.toBeNull()
    expect(session?.environment).toEqual({ APP_NAME: 'Oven' })
    expect(session?.args).toEqual(['-l'])
    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    expect(directory.startsWith(root)).toBe(true)
    expect(session?.variables['ZDOTDIR']).toBe(directory)

    // The shell writes its request under a temporary name and renames it in.
    await writeFile(join(directory, 'req.1.tmp'), '/repo\nbun run deploy\n', { mode: 0o600 })
    await rm(join(directory, 'req.1'), { force: true }).catch(() => undefined)
    const { rename } = await import('fs/promises')
    await rename(join(directory, 'req.1.tmp'), join(directory, 'req.1'))

    const response = await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    expect(response).toContain('names.1')
    expect(await readFile(join(directory, 'res.1'), 'utf8')).toBe(
      "export STRIPE_KEY='sk_live_1'\\'''\n"
    )
    expect(await readFile(join(directory, 'names.1'), 'utf8')).toBe('STRIPE_KEY\n')
    expect((await stat(join(directory, 'res.1'))).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).not.toContain('req.1')
  })

  it('answers an admitted command with nothing, so the line runs unshortened', async () => {
    session = await installTerminalEnvHook({
      sessionId: 'zsh',
      shell: '/bin/zsh',
      deferred: ['STRIPE_KEY'],
      environment: {},
      resolve: async () => ({}),
      root
    })
    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    await writeFile(join(directory, 'req.1'), '/repo\necho hi\n')

    await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    expect(await readFile(join(directory, 'res.1'), 'utf8')).toBe('')
    expect(await readFile(join(directory, 'names.1'), 'utf8')).toBe('')
  })

  it('still answers when the resolver throws, so the shell never waits out its poll', async () => {
    session = await installTerminalEnvHook({
      sessionId: 'zsh',
      shell: '/bin/zsh',
      deferred: ['STRIPE_KEY'],
      environment: {},
      resolve: async () => {
        throw new Error('vault is locked')
      },
      root
    })
    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    await writeFile(join(directory, 'req.1'), '/repo\nbun run deploy\n')

    await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    expect(await readFile(join(directory, 'res.1'), 'utf8')).toBe('')
  })

  it('achieves a fish session with its hook on the command line', async () => {
    session = await installTerminalEnvHook({
      sessionId: 'fish',
      shell: '/opt/homebrew/bin/fish',
      deferred: ['STRIPE_KEY'],
      environment: {},
      resolve: async () => ({}),
      root
    })
    expect(session?.args[0]).toBe('-l')
    expect(session?.args[1]).toBe('-C')
    expect(session?.args[2]).toContain('fish_preexec')
  })

  it('removes the session directory, and every value in it, on dispose', async () => {
    session = await installTerminalEnvHook({
      sessionId: 'zsh',
      shell: '/bin/zsh',
      deferred: ['KEY'],
      environment: {},
      resolve: async () => ({ KEY: 'value' }),
      root
    })
    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    await writeFile(join(directory, 'req.1'), '/repo\nrun\n')
    await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    await session?.dispose()
    await expect(readdir(directory)).rejects.toThrow()
  })
})
