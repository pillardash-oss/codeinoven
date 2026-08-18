import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('$lib/stores/agent-debug.svelte', () => ({
  agentDebug: {
    trackInvoke: (): void => undefined,
    trackResult: (): void => undefined
  }
}))

beforeEach(() => {
  vi.resetModules()
})

describe('typed IPC runtime gating', () => {
  it('does not send the Electron feature-readiness channel through the remote PWA bridge', async () => {
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === 'thread:listAll') return []
      throw new Error(`Unexpected remote channel: ${channel}`)
    })
    ;(globalThis as { window?: unknown }).window = { api: { invoke } }

    const runtime = await import('$lib/runtime-context')
    runtime.markRemotePwaRuntime()
    const ipc = await import('$lib/ipc.svelte')

    await expect(ipc.invoke('thread:listAll')).resolves.toEqual([])
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('thread:listAll')
  })

  it('retains the Electron feature-readiness gate in the desktop renderer', async () => {
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel === 'app:waitForFeatures') return undefined
      if (channel === 'thread:listAll') return []
      throw new Error(`Unexpected desktop channel: ${channel}`)
    })
    ;(globalThis as { window?: unknown }).window = { api: { invoke } }

    const ipc = await import('$lib/ipc.svelte')

    await expect(ipc.invoke('thread:listAll')).resolves.toEqual([])
    expect(invoke).toHaveBeenNthCalledWith(1, 'app:waitForFeatures')
    expect(invoke).toHaveBeenNthCalledWith(2, 'thread:listAll')
  })
})
