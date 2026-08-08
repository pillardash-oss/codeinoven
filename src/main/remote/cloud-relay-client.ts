import { Logger } from '../logger'
import { decryptPayload, encryptPayload } from '../../renderer/lib/remote/session-security'

export interface CloudRelayClientOptions {
  apiOrigin: string
  deviceToken: string
  controlSecret: string
  onAuthenticated: () => void
  onDisconnected: (reason: string) => void
  onRpc: (
    channel: string,
    args: unknown[]
  ) => Promise<{ ok: boolean; result?: unknown; message?: string }>
}

export class CloudRelayClient {
  private socket: WebSocket | null = null
  private authenticated = false
  private closed = false

  constructor(private readonly options: CloudRelayClientOptions) {}

  connect(): void {
    this.closed = false
    const target = new URL('/v1/relay', this.options.apiOrigin)
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
    target.searchParams.set('role', 'desktop')
    const socket = new WebSocket(target)
    this.socket = socket

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'relay:authenticate', token: this.options.deviceToken }))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      this.handleMessage(event.data)
    }
    socket.onerror = () => {
      Logger.error('Remote cloud relay WebSocket failed')
    }
    socket.onclose = (event) => {
      this.authenticated = false
      if (!this.closed) {
        this.options.onDisconnected(event.reason || `relay-closed-${event.code}`)
      }
    }
  }

  close(): void {
    this.closed = true
    this.authenticated = false
    this.socket?.close()
    this.socket = null
  }

  async send(payload: unknown): Promise<void> {
    if (!this.authenticated || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    const encrypted = await encryptPayload(this.options.controlSecret, JSON.stringify(payload))
    this.socket.send(JSON.stringify({ type: 'relay:data', payload: encrypted }))
  }

  private handleMessage(text: string): void {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      record = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (record['type'] === 'relay:authenticated') {
      this.authenticated = true
      this.options.onAuthenticated()
      return
    }
    if (record['type'] === 'relay:data' && typeof record['payload'] === 'string') {
      void decryptPayload(this.options.controlSecret, record['payload'])
        .then((plaintext) => this.handleEncryptedMessage(plaintext))
        .catch(() => {
          Logger.error('Remote cloud relay payload authentication failed')
          this.socket?.close()
        })
    }
  }

  private handleEncryptedMessage(plaintext: string): void {
    let record: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(plaintext)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
      record = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (record['rpc'] !== 'invoke' || typeof record['id'] !== 'number') return
    const id = record['id']
    const channel = typeof record['channel'] === 'string' ? record['channel'] : ''
    const args = Array.isArray(record['args']) ? record['args'] : []
    void this.options
      .onRpc(channel, args)
      .then((outcome) =>
        this.send(
          outcome.ok
            ? { rpc: 'result', id, result: outcome.result }
            : { rpc: 'error', id, message: outcome.message ?? 'Remote invocation failed' }
        )
      )
  }
}
