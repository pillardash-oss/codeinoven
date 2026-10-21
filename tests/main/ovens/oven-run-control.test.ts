import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OvenRegistry } from '../../../src/main/ovens/oven-registry'

// The service client reads its own bundle through Electron, and reaches the
// desktop's Git identity through two side-channel modules. Neither is what these
// tests are about: the question here is which service a run-control request
// reaches.
vi.mock('electron', () => ({ app: { getAppPath: () => '/nonexistent' } }))
vi.mock('../../../src/main/ovens/oven-local-git-trust', () => ({
  syncLocalGitHostTrust: vi.fn(async () => undefined)
}))
vi.mock('../../../src/main/ovens/oven-local-git-identity', () => ({
  mirrorLocalGitIdentity: vi.fn(async () => ({ file: '/oven/.ssh/codeinoven-local-github' })),
  OVEN_GIT_NETWORK_CHANNELS: new Set(['git:fetch', 'git:pull', 'git:push'])
}))

const { OvenService } = await import('../../../src/main/ovens/oven-service')
const { OvenChannelUnavailable, OvenRequestChannel, OvenServiceOutdated } =
  await import('../../../src/main/ovens/oven-request-channel')
const { OvenSsh } = await import('../../../src/main/ovens/oven-ssh')

function service(): InstanceType<typeof OvenService> {
  return new OvenService({} as OvenRegistry)
}

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * An Oven that cannot update and cannot be asked to work until it does.
 *
 * Its service reports another revision, and replacing that service is refused
 * because one of its runs is still active. That combination used to make Stop
 * impossible: the request that would end the run went through the same guard
 * that demanded the new service.
 */
function outdatedWithActiveRun() {
  return vi
    .spyOn(OvenRequestChannel.prototype, 'request')
    .mockImplementation(
      async (
        _id: string,
        _payload: string,
        _timeoutMs?: number,
        options?: { acceptOutdated?: boolean }
      ) =>
        options?.acceptOutdated
          ? JSON.stringify({ ok: true, value: null })
          : Promise.reject(new OvenServiceOutdated('The Oven is running an older service.'))
    )
}

describe('oven run control', () => {
  it('stops a run on the service the Oven already runs, without needing the current one', async () => {
    const oven = service()
    const request = outdatedWithActiveRun()
    const install = vi
      .spyOn(oven, 'install')
      .mockRejectedValue(new Error('Finish active runs before updating the Oven service.'))

    await expect(oven.stop('oven-a', 'run-1')).resolves.toBeUndefined()

    // Stop reached the Oven on the control path, and nothing spent an install
    // that the active run makes impossible.
    expect(request).toHaveBeenCalledOnce()
    expect(JSON.parse(String(request.mock.calls[0]?.[1]))).toMatchObject({
      method: 'stop',
      runId: 'run-1'
    })
    expect(install).not.toHaveBeenCalled()
  })

  it('reads the events of a run on an outdated service, so Stop can confirm it ended', async () => {
    const oven = service()
    const request = vi
      .spyOn(OvenRequestChannel.prototype, 'request')
      .mockImplementation(
        async (
          _id: string,
          _payload: string,
          _timeoutMs?: number,
          options?: { acceptOutdated?: boolean }
        ) =>
          options?.acceptOutdated
            ? JSON.stringify({
                ok: true,
                value: { run: { id: 'run-1', status: 'stopped' }, events: [] }
              })
            : Promise.reject(new OvenServiceOutdated('The Oven is running an older service.'))
      )

    await expect(oven.events('oven-a', 'run-1', 0)).resolves.toMatchObject({
      run: { status: 'stopped' }
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('delivers the stop in its own process when no session will open', async () => {
    const oven = service()
    vi.spyOn(OvenRequestChannel.prototype, 'request').mockRejectedValue(
      new OvenChannelUnavailable('The Oven channel could not be started.')
    )
    const execute = vi
      .spyOn(OvenSsh.prototype, 'execute')
      .mockImplementation(async (_id, command) =>
        command.includes('uname -s') ? 'Linux' : JSON.stringify({ ok: true, value: null })
      )

    await expect(oven.stop('oven-a', 'run-1')).resolves.toBeUndefined()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(execute.mock.calls.at(-1)?.[2]))).toMatchObject({
      method: 'stop',
      runId: 'run-1'
    })
  })
})
