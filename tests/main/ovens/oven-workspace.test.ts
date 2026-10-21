import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OvenSsh } from '../../../src/main/ovens/oven-ssh'
import type { OvenRegistry } from '../../../src/main/ovens/oven-registry'
import {
  normalizeGitHubSshUrl,
  ovenGitEnvironment,
  ovenWorkspace
} from '../../../src/main/ovens/remote/oven-workspace'

describe('oven SSH workspace writes', () => {
  it('normalizes GitHub HTTPS and SSH origins to the dedicated-key SSH URL', () => {
    expect(normalizeGitHubSshUrl('https://github.com/acme/widget')).toBe(
      'git@github.com:acme/widget.git'
    )
    expect(normalizeGitHubSshUrl('git@github.com:acme/widget.git')).toBe(
      'git@github.com:acme/widget.git'
    )
  })

  it('rejects origins outside the dedicated GitHub SSH channel', () => {
    expect(normalizeGitHubSshUrl('https://example.com/acme/widget')).toBeNull()
    expect(normalizeGitHubSshUrl('https://user:secret@github.com/acme/widget')).toBeNull()
    expect(normalizeGitHubSshUrl('https://github.com/acme/widget?ref=main')).toBeNull()
  })

  it('sends private data on stdin and installs the file with owner-only permissions', async () => {
    const ssh = new OvenSsh({} as OvenRegistry)
    const execute = vi.spyOn(ssh, 'execute').mockResolvedValue('')
    const privateKey = 'private-key-material'
    await ssh.putHomeSecretFile('oven-test', '.ssh/codeinoven-github', privateKey, {
      windows: false
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).not.toContain(privateKey)
    expect(execute.mock.calls[0]?.[2]).toBe(privateKey)
    expect(execute.mock.calls[0]?.[1]).toContain('chmod 700')
    expect(execute.mock.calls[0]?.[1]).toContain('chmod 600')
  })

  it('rejects traversal before opening an SSH channel', async () => {
    const ssh = new OvenSsh({} as OvenRegistry)
    const execute = vi.spyOn(ssh, 'execute').mockResolvedValue('')
    await expect(ssh.putHomeSecretFile('oven-test', '../outside', 'secret')).rejects.toThrow(
      'Invalid remote home-relative path'
    )
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('oven scope checkouts', () => {
  it('adopts an existing checkout of the same repository instead of cloning again', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cio-scope-'))
    const root = join(base, 'scope')
    await mkdir(root, { recursive: true })
    await run('git', ['init', '--quiet', root])
    await run('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:acme/widget.git'])

    const result = await ovenWorkspace({
      operation: 'clone',
      root,
      url: 'https://github.com/acme/widget'
    })

    // The checkout that is already there is the answer; no second clone happens.
    expect(result.root).toBe(root)
    await rm(base, { recursive: true, force: true })
  })

  it('refuses a checkout at that path that belongs to another repository', async () => {
    const base = await mkdtemp(join(tmpdir(), 'cio-scope-'))
    const root = join(base, 'scope')
    await mkdir(root, { recursive: true })
    await run('git', ['init', '--quiet', root])
    await run('git', ['-C', root, 'remote', 'add', 'origin', 'git@github.com:acme/other.git'])

    await expect(
      ovenWorkspace({ operation: 'clone', root, url: 'https://github.com/acme/widget' })
    ).rejects.toThrow('belongs to a different repository')
    await rm(base, { recursive: true, force: true })
  })
})

function run(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    spawn(program, args, { stdio: 'ignore' }).once('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${program} exited with ${String(code)}`))
    )
  })
}

describe('oven git environment', () => {
  /**
   * How `GIT_SSH_COMMAND` spells a path: Git parses that string with shell rules,
   * so the Oven-side command doubles every backslash and Windows paths carry one
   * per separator. Quoted the same way here so the assertion holds on both.
   */
  function commandPath(path: string): string {
    return `"${path.replace(/\\/gu, '\\\\')}"`
  }

  /** Run one case against a private home so this machine's own keys never leak in. */
  async function withHome(
    files: Record<string, string>,
    run: (home: string) => Promise<void>
  ): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), 'cio-git-env-'))
    // The environment reads the home directory through `os.homedir()`, which
    // resolves USERPROFILE on Windows and HOME elsewhere, so pin both to the
    // scratch home instead of this machine's real one.
    const homeVariables = ['HOME', 'USERPROFILE'] as const
    const previous = homeVariables.map((name) => process.env[name])
    for (const name of homeVariables) process.env[name] = home
    try {
      await mkdir(join(home, '.ssh'), { recursive: true })
      for (const [name, contents] of Object.entries(files))
        await writeFile(join(home, name), contents)
      await run(home)
    } finally {
      for (const [index, name] of homeVariables.entries()) {
        const value = previous[index]
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await rm(home, { recursive: true, force: true })
    }
  }

  it('leaves a machine whose own Git is configured completely alone', async () => {
    await withHome({}, async () => {
      // Nothing of ours to offer, so nothing is overridden: the Oven's own
      // core.sshCommand, agent, or HTTPS helper stays the credential.
      expect(await ovenGitEnvironment()).toEqual({})
      expect(await ovenGitEnvironment('.ssh/codeinoven-local-github')).toEqual({})
    })
  })

  it('uses the mirror already on the Oven even for a read that carried none', async () => {
    await withHome(
      {
        '.ssh/codeinoven-local-github': 'private key',
        '.ssh/codeinoven-local-github-known-hosts': 'github host key'
      },
      async (home) => {
        const env = await ovenGitEnvironment()
        expect(env['GIT_SSH_VARIANT']).toBe('ssh')
        expect(env['GIT_SSH_COMMAND']).toContain(
          `-i ${commandPath(join(home, '.ssh/codeinoven-local-github'))}`
        )
        expect(env['GIT_SSH_COMMAND']).toContain('UserKnownHostsFile=')
        expect(env['GIT_SSH_COMMAND']).toContain('BatchMode=yes')
      }
    )
  })

  it('prefers a dedicated identity for this Oven over the mirror', async () => {
    await withHome(
      {
        '.ssh/codeinoven-github': 'dedicated key',
        '.ssh/codeinoven-local-github': 'mirror key'
      },
      async (home) => {
        const env = await ovenGitEnvironment('.ssh/codeinoven-local-github')
        expect(env['GIT_SSH_COMMAND']).toContain(
          `-i ${commandPath(join(home, '.ssh/codeinoven-github'))}`
        )
        expect(env['GIT_SSH_COMMAND']).not.toContain('codeinoven-local-github')
      }
    )
  })
})
