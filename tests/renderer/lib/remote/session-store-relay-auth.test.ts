/**
 * Focused tests for the relay device-authentication gating in the remote
 * session store: queued RPC is not released until `remote:device:ok`, and a
 * failed or timed-out authentication surfaces a failure without sending.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AccountRelayEvent } from '../../../../src/renderer/lib/remote/account-relay'
import {
  createMemoryDeviceKeyStore,
  loadOrCreateDeviceKeyMaterial,
  type DeviceKeyMaterial
} from '$lib/remote/device-identity'
import { RemoteSessionStore } from '$lib/remote/session-store.svelte'

const { relayOnEvent, sentFrames, identityOverride } = vi.hoisted(() => {
  return {
    relayOnEvent: { current: null as ((event: AccountRelayEvent) => void) | null },
    sentFrames: { current: [] as string[] },
    identityOverride: { current: null as DeviceKeyMaterial | null }
  }
})

vi.mock('$lib/remote/device-identity', async (importOriginal) => {
  const original = await importOriginal<typeof import('$lib/remote/device-identity')>()
  return {
    ...original,
    loadOrCreateDeviceKeyMaterial: async (
      options?: Parameters<typeof original.loadOrCreateDeviceKeyMaterial>[0]
    ) => identityOverride.current ?? original.loadOrCreateDeviceKeyMaterial(options)
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

async function waitForRelayClient(store: RemoteSessionStore): Promise<void> {
  await vi.waitFor(() => {
    const client = (store as unknown as { accountRelayClient: unknown }).accountRelayClient
    expect(client).not.toBeNull()
  })
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
  identityOverride.current = null
})

describe('RemoteSessionStore — relay device auth gating', () => {
  it('does not release queued RPC until the device authenticates', async () => {
    const store = new RemoteSessionStore()
    const connection = store.connectCloud({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })
    await waitForRelayClient(store)

    // RPC sent before the device challenge/ok is held back.
    void store.sendPayload({ rpc: 'invoke', id: 1, channel: 'project:list', args: [] })
    await waitForRelayClient(store)
    await waitForRelayClient(store)
    expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(false)

    // The desktop issues its challenge; the phone replies (auth frame sent).
    message({ type: 'remote:device:challenge', nonce: 'challenge-1' })
    await vi.waitFor(() => {
      expect(
        sentFrames.current.some(
          (f) =>
            f.includes('remote:device:auth') &&
            f.includes('challenge-1') &&
            f.includes('connectionId')
        )
      ).toBe(true)
    })

    // Desktop confirms the binding → queued RPC is released.
    message({ type: 'remote:device:ok', device: { id: 'dev-1', authVersion: 1 } })
    await connection
    await vi.waitFor(() => {
      expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(true)
    })
    store.disconnect()
  })

  it('rejects authentication on remote:device:error and never sends queued RPC', async () => {
    const store = new RemoteSessionStore()
    const connection = store.connectCloud({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })
    await waitForRelayClient(store)

    message({ type: 'remote:device:challenge', nonce: 'challenge-1' })
    await vi.waitFor(() => {
      expect(sentFrames.current.some((f) => f.includes('remote:device:auth'))).toBe(true)
    })
    message({ type: 'remote:device:error', reason: 'signature_invalid' })
    await expect(connection).rejects.toThrow(
      'Relay device authentication failed: signature_invalid'
    )

    await expect(
      store.sendPayload({ rpc: 'invoke', id: 2, channel: 'project:list', args: [] })
    ).rejects.toThrow('Relay device authentication failed: signature_invalid')
    expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(false)
    store.disconnect()
  })

  it('re-enrolls with the approved bootstrap when the saved id belongs to another desktop', async () => {
    const material = await loadOrCreateDeviceKeyMaterial({
      store: createMemoryDeviceKeyStore()
    })
    identityOverride.current = { ...material, deviceId: 'other-desktop-device', authVersion: 2 }
    const store = new RemoteSessionStore()
    const connection = store.connectCloud({
      desktopId: 'fresh-desktop',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'fresh-bootstrap'
    })
    await waitForRelayClient(store)

    void store.sendPayload({ rpc: 'invoke', id: 4, channel: 'project:list', args: [] })
    message({ type: 'remote:device:challenge', nonce: 'challenge-old-id' })
    await vi.waitFor(() => {
      expect(
        sentFrames.current.some(
          (frame) => frame.includes('remote:device:auth') && frame.includes('other-desktop-device')
        )
      ).toBe(true)
    })

    message({ type: 'remote:device:error', reason: 'not_found' })
    await vi.waitFor(() => {
      expect(sentFrames.current.some((frame) => frame.includes('challenge-request'))).toBe(true)
    })
    expect(store.snapshot.route.kind).not.toBe('RELAY_CONNECTED')
    expect(sentFrames.current.some((frame) => frame.includes('project:list'))).toBe(false)
    message({ type: 'remote:device:challenge', nonce: 'challenge-bootstrap' })
    await vi.waitFor(() => {
      expect(
        sentFrames.current.some(
          (frame) => frame.includes('challenge-bootstrap') && frame.includes('fresh-bootstrap')
        )
      ).toBe(true)
    })

    message({ type: 'remote:device:ok', device: { id: 'fresh-device', authVersion: 1 } })
    await connection
    await vi.waitFor(() => {
      expect(sentFrames.current.some((frame) => frame.includes('project:list'))).toBe(true)
    })
    store.disconnect()
  })

  it('gates queued RPC until an authentication timeout resolves it as a failure', async () => {
    vi.useFakeTimers()
    const store = new RemoteSessionStore()
    const connection = store.connectCloud({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })
    await waitForRelayClient(store)

    // No challenge/ok arrives within the deadline.
    const pendingSend = store.sendPayload({
      rpc: 'invoke',
      id: 3,
      channel: 'project:list',
      args: []
    })
    const sendRejection = expect(pendingSend).rejects.toThrow(
      'Relay device authentication timed out'
    )
    const connectionRejection = expect(connection).rejects.toThrow(
      'Relay device authentication timed out'
    )
    await vi.advanceTimersByTimeAsync(13_000)
    await connectionRejection
    await sendRejection
    expect(sentFrames.current.some((f) => f.includes('project:list'))).toBe(false)
    store.disconnect()
  })

  it('preserves the workspace and reconnects when a suspended relay resumes', async () => {
    const store = new RemoteSessionStore()
    const firstConnection = store.connectAccountDesktop({
      desktopId: 'desktop-1',
      mobileDeviceId: 'mobile-1',
      controlSecret: 'secret'
    })
    await waitForRelayClient(store)
    message({ type: 'remote:device:challenge', nonce: 'challenge-1' })
    await vi.waitFor(() => {
      expect(sentFrames.current.some((frame) => frame.includes('challenge-1'))).toBe(true)
    })
    message({ type: 'remote:device:ok', device: { id: 'dev-1', authVersion: 1 } })
    await firstConnection

    store.suspend()
    expect(store.recovering).toBe(true)
    expect(store.snapshot.route.kind).toBe('RELAY_CONNECTED')

    const resumed = store.resume()
    await waitForRelayClient(store)
    expect(store.recovering).toBe(true)
    message({ type: 'remote:device:challenge', nonce: 'challenge-2' })
    await vi.waitFor(() => {
      expect(sentFrames.current.some((frame) => frame.includes('challenge-2'))).toBe(true)
    })
    message({ type: 'remote:device:ok', device: { id: 'dev-1', authVersion: 1 } })
    await resumed

    expect(store.recovering).toBe(false)
    expect(store.snapshot.route.kind).toBe('RELAY_CONNECTED')
    store.disconnect()
  })
})
