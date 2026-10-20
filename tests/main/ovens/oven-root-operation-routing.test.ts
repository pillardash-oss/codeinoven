import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OvenRegistry } from '../../../src/main/ovens/oven-registry'

// The service client reads its own bundle through Electron, and reaches the
// desktop's Git identity through two side-channel modules. Neither is what these
// tests are about: the question here is which route an action takes.
vi.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent' } }))
vi.mock('../../../src/main/ovens/oven-local-git-trust', () => ({
  syncLocalGitHostTrust: vi.fn(async () => undefined)
}))
vi.mock('../../../src/main/ovens/oven-local-git-identity', () => ({
  mirrorLocalGitIdentity: vi.fn(async () => ({ file: '/oven/.ssh/codeinoven-local-github' })),
  OVEN_GIT_NETWORK_CHANNELS: new Set(['git:fetch', 'git:pull', 'git:push'])
}))

const { OvenService } = await import('../../../src/main/ovens/oven-service')
const { OvenChannelUnavailable, OvenRequestChannel, OvenServiceOutdated } = await import(
  '../../../src/main/ovens/oven-request-channel'
)
const { OvenSsh } = await import('../../../src/main/ovens/oven-ssh')

function service(): InstanceType<typeof OvenService> {
  return new OvenService({} as OvenRegistry)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('oven root operations', () => {
  it('sends a file action over the warm session instead of a new ssh process', async () => {
    const oven = service()
    const request = vi
      .spyOn(OvenRequestChannel.prototype, 'request')
      .mockResolvedValue(JSON.stringify({ ok: true, value: { path: 'notes.md' } }))
    const execute = vi.spyOn(OvenSsh.prototype, 'execute').mockResolvedValue('')

    const result = await oven.rootOperation('oven-a', '/checkout', 'project-1', 'projectFiles:create', [
      'docs',
      'notes.md'
    ])

    expect(result).toEqual({ path: 'notes.md' })
    expect(request).toHaveBeenCalledOnce()
    const [id, payload, timeoutMs] = request.mock.calls[0] ?? []
    expect(id).toBe('oven-a')
    expect(JSON.parse(String(payload))).toMatchObject({
      root: '/checkout',
      projectId: 'project-1',
      channel: 'projectFiles:create'
    })
    // A Git command on a large checkout may legitimately take a minute, so the
    // session must not be judged wedged at the 30 s control-message timeout.
    expect(timeoutMs).toBe(120_000)
    // The one thing that made a folder take seconds: a second ssh and Node start.
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps network Git on its own invocation, which is the one that forwards the agent', async () => {
    const oven = service()
    const request = vi.spyOn(OvenRequestChannel.prototype, 'request')
    const execute = vi
      .spyOn(OvenSsh.prototype, 'execute')
      .mockImplementation(async (_id, command) =>
        command.includes('uname -s') ? 'Linux' : JSON.stringify({ ok: true, value: null })
      )

    await oven.rootOperation('oven-a', '/checkout', 'project-1', 'git:push', [])

    expect(request).not.toHaveBeenCalled()
    const operation = execute.mock.calls.at(-1)
    expect(operation?.[1]).toContain('root-operation')
    // Agent forwarding is why this route stays separate from the shared session.
    expect(operation?.[5]).toBe(true)
    expect(operation?.[6]).toBe(8 * 1024 * 1024)
    expect(JSON.parse(String(operation?.[2]))).toMatchObject({
      localIdentityFile: '/oven/.ssh/codeinoven-local-github'
    })
  })

  it('replaces an outdated Oven service once, then runs the same action again', async () => {
    const oven = service()
    const request = vi
      .spyOn(OvenRequestChannel.prototype, 'request')
      .mockRejectedValueOnce(new OvenServiceOutdated('The Oven is running an older service.'))
      .mockResolvedValueOnce(JSON.stringify({ ok: true, value: true }))
    const install = vi.spyOn(oven, 'install').mockResolvedValue({} as never)

    await expect(
      oven.rootOperation('oven-a', '/checkout', 'project-1', 'projectFiles:list', [''])
    ).resolves.toBe(true)
    expect(install).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('starts the service the Oven already has when nothing is listening', async () => {
    const oven = service()
    const notListening = new OvenChannelUnavailable(
      'connect ENOENT /home/dev/.config/pillardash/codeinoven/ovens/service.sock'
    )
    vi.spyOn(OvenRequestChannel.prototype, 'request')
      .mockRejectedValueOnce(notListening)
      .mockResolvedValueOnce(JSON.stringify({ ok: true, value: ['notes.md'] }))
    const install = vi.spyOn(oven, 'install').mockResolvedValue({} as never)

    // A POSIX Oven loses its daemon on reboot. That is the app's own service to
    // start again, not a request failure to hand the user.
    await expect(
      oven.rootOperation('oven-a', '/checkout', 'project-1', 'projectFiles:list', [''])
    ).resolves.toEqual(['notes.md'])
    expect(install).toHaveBeenCalledOnce()
  })

  it('does not mistake an unreachable Oven for a stopped service', async () => {
    const oven = service()
    vi.spyOn(OvenRequestChannel.prototype, 'request').mockRejectedValue(
      new OvenChannelUnavailable('ssh: connect to host 192.168.64.10 port 22: Connection timed out')
    )
    const install = vi.spyOn(oven, 'install').mockResolvedValue({} as never)
    const execute = vi
      .spyOn(OvenSsh.prototype, 'execute')
      .mockRejectedValue(new Error('ssh: connect to host 192.168.64.10 port 22: Connection timed out'))

    await expect(
      oven.rootOperation('oven-a', '/checkout', 'project-1', 'projectFiles:list', [''])
    ).rejects.toThrow('Connection timed out')
    expect(install).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalled()
  })

  it('reports an outdated service it could not replace instead of a channel failure', async () => {
    const oven = service()
    vi.spyOn(OvenRequestChannel.prototype, 'request').mockRejectedValue(
      new OvenServiceOutdated('The Oven is running an older service.')
    )
    vi.spyOn(oven, 'install').mockRejectedValue(new Error('Finish active runs before updating.'))

    await expect(
      oven.rootOperation('oven-a', '/checkout', 'project-1', 'projectFiles:list', [''])
    ).rejects.toThrow('runs an older service')
  })
})
