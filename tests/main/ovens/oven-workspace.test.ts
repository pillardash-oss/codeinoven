import { describe, expect, it, vi } from 'vitest'
import { OvenSsh } from '../../../src/main/ovens/oven-ssh'
import type { OvenRegistry } from '../../../src/main/ovens/oven-registry'
import { normalizeGitHubSshUrl } from '../../../src/main/ovens/remote/oven-workspace'

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
    await ssh.putHomeSecretFile('oven-test', '.ssh/codeinoven-github', privateKey)
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]?.[1]).not.toContain(privateKey)
    expect(execute.mock.calls[0]?.[2]).toBe(privateKey)
    expect(execute.mock.calls[0]?.[1]).toContain('chmod 700')
    expect(execute.mock.calls[0]?.[1]).toContain('chmod 600')
  })

  it('rejects traversal before opening an SSH channel', async () => {
    const ssh = new OvenSsh({} as OvenRegistry)
    const execute = vi.spyOn(ssh, 'execute').mockResolvedValue('')
    await expect(ssh.putHomeSecretFile('oven-test', '../outside', 'secret')).rejects.toThrow('Invalid remote home-relative path')
    expect(execute).not.toHaveBeenCalled()
  })
})
