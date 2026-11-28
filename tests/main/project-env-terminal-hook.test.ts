import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { projectEnvTerminalHook } from '../../src/main/secrets/project-env-terminal-hook'

/** A scratch folder under the project, never the OS temp tree. */
const SCRATCH = join(process.cwd(), '.cio/tmp/env-hook-binding')

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== null) return value
    if (Date.now() - started > timeoutMs) throw new Error('The hook never answered')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('projectEnvTerminalHook', () => {
  const projectRoot = '/repo'
  let root: string
  let dispose: (() => Promise<void>) | null

  beforeEach(async () => {
    root = join(SCRATCH, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })
    dispose = null
  })

  afterEach(async () => {
    await dispose?.()
    await rm(root, { recursive: true, force: true })
  })

  it('stays out of a terminal when no rule waits for a command', async () => {
    const service = {
      interactiveEnvironment: vi.fn().mockResolvedValue({
        environment: { API_URL: 'https://api' },
        preview: { entries: [], disabled: [], skipped: [] },
        deferred: [],
        ruleDeferred: []
      }),
      deferredEnvironment: vi.fn()
    }
    const hook = projectEnvTerminalHook({
      service,
      resolveProjectPath: async () => projectRoot,
      hookRoot: root
    })

    await expect(
      hook({
        sessionId: 'term-1',
        shell: '/bin/zsh',
        projectId: 'p1',
        threadId: 't1',
        cwd: projectRoot,
        directory: ''
      })
    ).resolves.toBeNull()
    expect(service.deferredEnvironment).not.toHaveBeenCalled()
  })

  it('asks for the admitted names in the directory the shell is standing in', async () => {
    const service = {
      interactiveEnvironment: vi.fn().mockResolvedValue({
        environment: { API_URL: 'https://api' },
        preview: { entries: [], disabled: [], skipped: [] },
        deferred: ['STRIPE_KEY', 'PLAIN'],
        ruleDeferred: ['STRIPE_KEY']
      }),
      deferredEnvironment: vi
        .fn()
        .mockResolvedValue({ environment: { STRIPE_KEY: 'sk_live_1' }, deferred: [] })
    }
    const hook = projectEnvTerminalHook({
      service,
      resolveProjectPath: async () => projectRoot,
      hookRoot: root
    })
    const session = await hook({
      sessionId: 'term-2',
      shell: '/bin/zsh',
      projectId: 'p1',
      threadId: 't1',
      cwd: projectRoot,
      directory: ''
    })
    expect(session).not.toBeNull()
    dispose = session?.dispose ?? null
    expect(session?.environment).toEqual({ API_URL: 'https://api' })

    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    // The shell reports the directory it is in, so a `cd` inside the terminal is
    // what decides which env group a rule is compared against.
    await writeFile(join(directory, 'req.1.tmp'), `${projectRoot}/packages/api\nbun run api\n`)
    await rename(join(directory, 'req.1.tmp'), join(directory, 'req.1'))

    await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    // The service resolves the directory itself, so a linked folder is read both
    // as the path the shell walked and as the path it really leads to.
    expect(service.deferredEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: `${projectRoot}/packages/api`, command: 'bun run api' }),
      ['STRIPE_KEY', 'PLAIN']
    )
    expect(await readFile(join(directory, 'res.1'), 'utf8')).toContain(
      "export STRIPE_KEY='sk_live_1'"
    )
  })

  it('keeps the session directory for a cwd outside the project, like a worktree', async () => {
    const service = {
      interactiveEnvironment: vi.fn().mockResolvedValue({
        environment: {},
        preview: { entries: [], disabled: [], skipped: [] },
        deferred: ['STRIPE_KEY'],
        ruleDeferred: ['STRIPE_KEY']
      }),
      deferredEnvironment: vi.fn().mockResolvedValue({ environment: {}, deferred: [] })
    }
    const hook = projectEnvTerminalHook({
      service,
      resolveProjectPath: async () => projectRoot,
      hookRoot: root
    })
    const session = await hook({
      sessionId: 'term-3',
      shell: '/bin/zsh',
      projectId: 'p1',
      threadId: 't1',
      cwd: '/worktrees/feature',
      directory: 'packages/api'
    })
    dispose = session?.dispose ?? null
    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    await writeFile(join(directory, 'req.1'), '/worktrees/feature\nbun run api\n')

    await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    expect(service.deferredEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ directory: 'packages/api', cwd: '/worktrees/feature' }),
      ['STRIPE_KEY']
    )
  })
})

describe('projectEnvTerminalHook command directories', () => {
  const projectRoot = '/repo'
  let root: string
  let dispose: (() => Promise<void>) | null

  beforeEach(async () => {
    root = join(SCRATCH, `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })
    dispose = null
  })

  afterEach(async () => {
    await dispose?.()
    await rm(root, { recursive: true, force: true })
  })

  it('passes the package a line cds into, so the line sees that package env', async () => {
    const service = {
      interactiveEnvironment: vi.fn().mockResolvedValue({
        environment: {},
        preview: { entries: [], disabled: [], skipped: [] },
        deferred: ['API_ONLY'],
        ruleDeferred: []
      }),
      deferredEnvironment: vi.fn().mockResolvedValue({ environment: {}, deferred: [] })
    }
    const hook = projectEnvTerminalHook({
      service,
      resolveProjectPath: async () => projectRoot,
      hookRoot: root
    })
    const session = await hook({
      sessionId: 'term-4',
      shell: '/bin/zsh',
      projectId: 'p1',
      threadId: 't1',
      cwd: projectRoot,
      directory: ''
    })
    dispose = session?.dispose ?? null
    const directory = session?.variables['CIO_ENV_HOOK_DIR'] ?? ''
    await writeFile(
      join(directory, 'req.1.tmp'),
      `${projectRoot}\ncd packages/api && bun run api\n`
    )
    await rename(join(directory, 'req.1.tmp'), join(directory, 'req.1'))

    await waitFor(async () => {
      const names = await readdir(directory)
      return names.includes('res.1') ? names : null
    })
    expect(service.deferredEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: projectRoot,
        directories: expect.arrayContaining(['packages/api']),
        command: 'cd packages/api && bun run api'
      }),
      ['API_ONLY']
    )
  })
})
