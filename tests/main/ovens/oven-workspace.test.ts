import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OvenSsh } from '../../../src/main/ovens/oven-ssh'
import type { OvenRegistry } from '../../../src/main/ovens/oven-registry'
import { normalizeGitHubSshUrl, ovenWorkspace } from '../../../src/main/ovens/remote/oven-workspace'

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
