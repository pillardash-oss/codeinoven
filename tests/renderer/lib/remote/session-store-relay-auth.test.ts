/**
 * Focused tests for the relay device-authentication gating in the remote
 * session store: queued RPC is not released until `remote:device:ok`, and a
 * failed or timed-out authentication surfaces a failure without sending.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountRelayEvent } from '../../../../src/renderer/lib/remote/account-relay'
import { RemoteSessionStore } from '$lib/remote/session-store.svelte'

const { relayOnEvent, sentFrames } = vi.hoisted(() => {
  return {
    relayOnEvent: { current: null as ((event: AccountRelayEvent) => void) | null },
    sentFrames: { current: [] as string[] }
  }
})

vi.mock('$lib/remote/account-relay', () => ({
  createAccountRelayClient: (options: { onEvent: (event: AccountRelayEvent) => void }) => {
    relayOnEvent.current = options.onEvent
    return {
      connect: async (): Promise<'open' | 'offline' | 'failed'> => 'open',
      send: async (data: string): Promise<void> => {
        sentFrames.current.push(data)
      },
      close: (): void => undefined
    }
  }
}))

function message(record: unknown): void {
  relayOnEvent.current?.({ kind: 'message', data: JSON.stringify(record) })
}

beforeAll(() => {
  // The store uses a browser `window` (origin + timers); polyfill under vitest.
  if (!('window' in globalThis)) {
    ;(globalThis as { window?: unknown }).window = {
      location: { origin: 'http://localhost' },
      setTimeout: (handler: () => void, ms?: number): number =>
        setTimeout(handler, ms) as unknown as number,
      clearTimeout: (id: number): void => clearTimeout(id),
      setInterval: (handler: () => void, ms?: number): number =>
        setInterval(handler, ms) as unknown as number,
      clearInterval: (id: number): void => clearInterval(id)
    }
  }
})

afterEach(() => {
  vi.useRealTimers()
  sentFrames.current = []
  relayOnEvent.current = null
})

describe('RemoteSessionStore — relay device auth gating', () => {
  it('does not release queued RPC until the device authenticates', async () => {
    const store = new RemoteSessionStore()
    await store.connectCloud({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })

    // RPC sent before the device challenge/ok is held back.
    void store.sendPayload({ rpc: 'invoke', id: 1, channel: 'project:list', args: [] })
    await Promise.resolve()
    await Promise.resolve()
    expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(false)

    // The desktop issues its challenge; the phone replies (auth frame sent).
    message({ type: 'remote:device:challenge', nonce: 'challenge-1' })
    await vi.waitFor(() => {
      expect(
        sentFrames.current.some(
          (f) => f.includes('remote:device:auth') && f.includes('challenge-1')
        )
      ).toBe(true)
    })

    // Desktop confirms the binding → queued RPC is released.
    message({ type: 'remote:device:ok', device: { id: 'dev-1', authVersion: 1 } })
    await vi.waitFor(() => {
      expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(true)
    })
    store.disconnect()
  })

  it('rejects authentication on remote:device:error and never sends queued RPC', async () => {
    const store = new RemoteSessionStore()
    await store.connectCloud({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })

    message({ type: 'remote:device:challenge', nonce: 'challenge-1' })
    await vi.waitFor(() => {
      expect(sentFrames.current.some((f) => f.includes('remote:device:auth'))).toBe(true)
    })
    message({ type: 'remote:device:error', reason: 'signature_invalid' })

    await store.sendPayload({ rpc: 'invoke', id: 2, channel: 'project:list', args: [] })
    expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(false)
    store.disconnect()
  })

  it('gates queued RPC until an authentication timeout resolves it as a failure', async () => {
    vi.useFakeTimers()
    const store = new RemoteSessionStore()
    await store.connectCloud({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })

    // No challenge/ok arrives within the deadline.
    let sent = false
    void store.sendPayload({ rpc: 'invoke', id: 3, channel: 'project:list', args: [] }).then(() => {
      sent = true
    })
    await vi.advanceTimersByTimeAsync(13_000)
    expect(sent).toBe(true)
    expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(false)
    store.disconnect()
  })
})
