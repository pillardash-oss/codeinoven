import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('$lib/ipc.svelte', () => ({ invoke }))

const toastMock = vi.hoisted(() => ({ message: vi.fn() }))

vi.mock('svelte-sonner', () => ({ toast: toastMock }))

import { cloudDeployState } from '$lib/stores/cloud-deploy.svelte'
import type {
  CloudDeploymentContainer,
  CloudDeploymentProviderKind,
  CloudDeploymentResult
} from '$shared/types'

const providerKind: CloudDeploymentProviderKind = 'coolify'

const container: CloudDeploymentContainer = {
  id: 'app-1',
  label: 'My App',
  providerKind,
  status: 'success',
  url: 'https://app.example.com'
}

const overview: CloudDeploymentResult = {
  containers: [container],
  hasDeployments: true,
  fetchedAt: Date.now()
}

describe('CloudDeployState store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    invoke.mockReset()
    toastMock.message.mockReset()
    cloudDeployState.reset()
  })

  it('serves a fresh overview from cache without re-fetching', async () => {
    invoke.mockResolvedValue(overview)
    const first = await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(first).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(1)

    const second = await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(second).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('revalidates the overview after the TTL elapses', async () => {
    invoke.mockResolvedValue(overview)
    await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(invoke).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(61_000)
    const refreshed = await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(refreshed).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('serves stale overview data immediately and revalidates in the background', async () => {
    invoke.mockResolvedValue(overview)
    await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(invoke).toHaveBeenCalledTimes(1)

    // Age the cache past the TTL; the refetch is deferred so it hasn't resolved yet.
    vi.advanceTimersByTime(61_000)
    invoke.mockClear()

    const stale = await cloudDeployState.ensureOverview('project-1', providerKind)
    // Stale data is returned right away; the background revalidation is in flight.
    expect(stale).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(1)

    await vi.runAllTimersAsync()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('does not re-fetch a key during its failure cooldown', async () => {
    invoke.mockRejectedValue(
      new Error("Error invoking remote method 'cloudDeploy:overview': Error: boom")
    )
    await expect(cloudDeployState.ensureOverview('project-1', providerKind)).rejects.toThrow('boom')
    expect(invoke).toHaveBeenCalledTimes(1)

    const duringCooldown = await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(duringCooldown).toBeNull()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('retries a key once its failure cooldown has elapsed', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    await expect(cloudDeployState.ensureOverview('project-1', providerKind)).rejects.toThrow('boom')

    vi.advanceTimersByTime(121_000)
    invoke.mockResolvedValue(overview)
    const result = await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(result).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent overview fetches for the same key', async () => {
    let resolveOverview: (value: CloudDeploymentResult) => void
    invoke.mockImplementation(
      () =>
        new Promise<CloudDeploymentResult>((resolve) => {
          resolveOverview = resolve
        })
    )

    const first = cloudDeployState.ensureOverview('project-1', providerKind)
    const second = cloudDeployState.ensureOverview('project-1', providerKind)
    expect(invoke).toHaveBeenCalledTimes(1)

    resolveOverview!(overview)
    await expect(first).resolves.toEqual(overview)
    await expect(second).resolves.toEqual(overview)
  })

  it('deduplicates container status fetches for the same key', async () => {
    invoke.mockResolvedValue(container)
    const first = await cloudDeployState.ensureContainerStatus(
      'project-1',
      providerKind,
      container.id
    )
    expect(first).toEqual(container)

    const second = await cloudDeployState.ensureContainerStatus(
      'project-1',
      providerKind,
      container.id
    )
    expect(second).toEqual(container)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('caches container logs with a longer TTL', async () => {
    invoke.mockResolvedValue({ containerId: container.id, log: 'build ok' })
    await cloudDeployState.ensureContainerLog('project-1', providerKind, container.id)
    expect(invoke).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(60_000)
    await cloudDeployState.ensureContainerLog('project-1', providerKind, container.id)
    expect(invoke).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60_000 + 1_000)
    await cloudDeployState.ensureContainerLog('project-1', providerKind, container.id)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('updates a container status without re-fetching', async () => {
    invoke.mockResolvedValue(container)
    await cloudDeployState.ensureContainerStatus('project-1', providerKind, container.id)

    cloudDeployState.setContainerStatus('project-1', { ...container, status: 'building' })
    const updated = await cloudDeployState.ensureContainerStatus(
      'project-1',
      providerKind,
      container.id
    )
    expect(updated?.status).toBe('building')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('force bypasses the TTL and failure cooldown', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    await expect(cloudDeployState.ensureOverview('project-1', providerKind)).rejects.toThrow('boom')
    expect(invoke).toHaveBeenCalledTimes(1)

    invoke.mockResolvedValue(overview)
    const result = await cloudDeployState.ensureOverview('project-1', providerKind, true)
    expect(result).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('short-circuits a not-implemented stub kind with no IPC call and a toast', async () => {
    const result = await cloudDeployState.ensureOverview('project-1', 'netlify')
    expect(result).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
    expect(toastMock.message).toHaveBeenCalledTimes(1)
    expect(toastMock.message).toHaveBeenCalledWith(
      "Netlify deployments aren't available yet",
      expect.any(Object)
    )
  })

  it('does not repeat the not-implemented toast for the same stub kind', async () => {
    await cloudDeployState.ensureOverview('project-1', 'netlify')
    await cloudDeployState.ensureOverview('project-1', 'netlify', true)
    expect(invoke).not.toHaveBeenCalled()
    expect(toastMock.message).toHaveBeenCalledTimes(1)
  })

  it('short-circuits container status and log loads for stub kinds', async () => {
    const status = await cloudDeployState.ensureContainerStatus('project-1', 'vercel', 'app-1')
    const log = await cloudDeployState.ensureContainerLog('project-1', 'railway', 'app-1')
    expect(status).toBeNull()
    expect(log).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
    expect(toastMock.message).toHaveBeenCalledTimes(2)
  })

  it('monitorContainers fetches authoritative status per configured container, keyed by project', async () => {
    invoke.mockResolvedValue(container)
    await cloudDeployState.monitorContainers('project-1', [
      container,
      { ...container, id: 'app-2' }
    ])
    expect(invoke).toHaveBeenCalledTimes(2)

    // A second pass within the TTL serves cache and does not over-fetch.
    await cloudDeployState.monitorContainers('project-1', [
      container,
      { ...container, id: 'app-2' }
    ])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('monitorContainers does not share status caches across projects', async () => {
    invoke.mockResolvedValue(container)
    await cloudDeployState.monitorContainers('project-1', [container])
    await cloudDeployState.monitorContainers('project-2', [container])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('monitorContainers revalidates a container status after its TTL elapses', async () => {
    invoke.mockResolvedValue(container)
    await cloudDeployState.monitorContainers('project-1', [container])
    expect(invoke).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(61_000)
    await cloudDeployState.monitorContainers('project-1', [container])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('monitorContainers keeps stale data on screen during a failure cooldown', async () => {
    invoke.mockResolvedValue(container)
    await cloudDeployState.monitorContainers('project-1', [container])
    expect(invoke).toHaveBeenCalledTimes(1)

    invoke.mockRejectedValue(new Error('boom'))
    vi.advanceTimersByTime(61_000)
    await cloudDeployState.monitorContainers('project-1', [container])
    expect(invoke).toHaveBeenCalledTimes(2)

    // Inside the cooldown the failed key is not retried and stale data is kept.
    await cloudDeployState.monitorContainers('project-1', [container])
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not collide overview cache entries across projects for the same provider', async () => {
    invoke.mockResolvedValue(overview)
    await cloudDeployState.ensureOverview('project-1', providerKind)
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(2)

    // Each project's fresh entry is served from its own cache slot.
    await cloudDeployState.ensureOverview('project-1', providerKind)
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(2)

    // Revalidating one project leaves the other's entry untouched and fresh.
    vi.advanceTimersByTime(61_000)
    await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(invoke).toHaveBeenCalledTimes(3)
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('does not collide container status/log keys across projects for the same container', async () => {
    invoke.mockResolvedValue(container)
    await cloudDeployState.ensureContainerStatus('project-1', providerKind, container.id)
    await cloudDeployState.ensureContainerStatus('project-2', providerKind, container.id)
    expect(invoke).toHaveBeenCalledTimes(2)

    invoke.mockResolvedValue({ containerId: container.id, log: 'build ok' })
    await cloudDeployState.ensureContainerLog('project-1', providerKind, container.id)
    await cloudDeployState.ensureContainerLog('project-2', providerKind, container.id)
    expect(invoke).toHaveBeenCalledTimes(4)
  })

  it('does not share a failure cooldown across projects for the same provider', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    await expect(cloudDeployState.ensureOverview('project-1', providerKind)).rejects.toThrow('boom')
    expect(invoke).toHaveBeenCalledTimes(1)

    // project-2 has no failure recorded, so it is not blocked by project-1's cooldown.
    invoke.mockResolvedValue(overview)
    const result = await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(result).toEqual(overview)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('reset(projectId) clears only that project scoped data', async () => {
    invoke.mockResolvedValue(overview)
    await cloudDeployState.ensureOverview('project-1', providerKind)
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(2)

    cloudDeployState.reset('project-1')
    // project-1 refetches; project-2 is still served from its own cache.
    await cloudDeployState.ensureOverview('project-1', providerKind)
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('keeps every project cached when switching, so re-opening a project is instant', async () => {
    invoke.mockResolvedValue(overview)
    await cloudDeployState.ensureOverview('project-1', providerKind)
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(2)

    // Switching to project-2 must not drop project-1's cache.
    cloudDeployState.ensureProject('project-2')
    await cloudDeployState.ensureOverview('project-2', providerKind)
    expect(invoke).toHaveBeenCalledTimes(2)

    // Switching back to project-1 serves its cached overview without re-fetching.
    cloudDeployState.ensureProject('project-1')
    await cloudDeployState.ensureOverview('project-1', providerKind)
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
