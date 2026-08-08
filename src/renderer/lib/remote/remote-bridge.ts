/**
 * Renderer-side remote RPC bridge.
 *
 * Implements the same `invoke`/`subscribe` surface as the Electron `window.api`
 * bridge, but transports the calls over the encrypted WebSocket session to the
 * desktop gateway. The phone PWA installs this as `window.api` so the existing
 * renderer stores (thread messages, provider catalog, settings) run unchanged
 * on the phone.
 *
 * Protocol (encrypted inside `remote:data` frames):
 * - send: `{ rpc: 'invoke', id, channel, args }`
 * - recv: `{ rpc: 'result', id, result }` | `{ rpc: 'error', id, message }`
 * - recv: `{ rpc: 'event', channel, payload }`
 */

import { remoteSession } from './session-store.svelte'

type PendingInvoke = {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

class RemoteRpcBridge {
  private nextId = 1
  private readonly pending = new Map<number, PendingInvoke>()
  private readonly eventListeners = new Map<string, Set<(...args: unknown[]) => void>>()
  private listening = false

  /** Install the listener on the remote session (idempotent). */
  private ensureListening(): void {
    if (this.listening) return
    this.listening = true
    remoteSession.onMessage((plaintext) => {
      this.handleFrame(plaintext)
    })
  }

  private handleFrame(plaintext: string): void {
    let frame: unknown
    try {
      frame = JSON.parse(plaintext)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const record = frame as Record<string, unknown>

    if (record.rpc === 'result' && typeof record.id === 'number') {
      const pending = this.pending.get(record.id)
      if (pending) {
        this.pending.delete(record.id)
        pending.resolve(record.result)
      }
      return
    }
    if (record.rpc === 'error' && typeof record.id === 'number') {
      const pending = this.pending.get(record.id)
      if (pending) {
        this.pending.delete(record.id)
        pending.reject(new Error(String(record.message ?? 'Remote invoke failed')))
      }
      return
    }
    if (record.rpc === 'event' && typeof record.channel === 'string') {
      const listeners = this.eventListeners.get(record.channel)
      if (listeners) {
        const payload = record.payload
        const args = Array.isArray(payload) ? payload : [payload]
        for (const listener of listeners) listener(...args)
      }
    }
  }

  /** Invoke a desktop channel; returns the result or rejects on error. */
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.ensureListening()
    if (
      remoteSession.snapshot.route.kind !== 'LAN_CONNECTED' &&
      remoteSession.snapshot.route.kind !== 'RELAY_CONNECTED'
    ) {
      throw new Error('Not connected to the desktop yet')
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void remoteSession
        .sendPayload({ rpc: 'invoke', id, channel, args })
        .catch((error: unknown) => {
          this.pending.delete(id)
          reject(error instanceof Error ? error : new Error(String(error)))
        })
    })
  }

  /** Subscribe to a desktop-pushed event channel; returns an unsubscribe fn. */
  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    this.ensureListening()
    let listeners = this.eventListeners.get(channel)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(channel, listeners)
    }
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  }
}

export const remoteBridge = new RemoteRpcBridge()

/** Whether the phone is connected to a desktop over the remote bridge. */
export function isRemoteConnected(): boolean {
  return (
    remoteSession.snapshot.route.kind === 'LAN_CONNECTED' ||
    remoteSession.snapshot.route.kind === 'RELAY_CONNECTED'
  )
}

/** Convenience wrapper used by the phone chat stores. */
export async function remoteInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return remoteBridge.invoke(channel, ...args)
}

export function remoteSubscribe(
  channel: string,
  callback: (...args: unknown[]) => void
): () => void {
  return remoteBridge.on(channel, callback)
}
