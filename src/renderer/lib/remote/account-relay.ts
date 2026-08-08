import { decryptPayload, encryptPayload } from './session-security'
import { remoteLog } from './logger'

export type AccountRelayEvent =
  | { kind: 'connected'; url: string }
  | { kind: 'offline' }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'message'; data: string }

export interface AccountRelayClient {
  connect(): Promise<'open' | 'offline' | 'failed'>
  send(data: string): Promise<void>
  close(): void
}

export interface AccountRelayOptions {
  desktopId: string
  mobileDeviceId: string
  controlSecret: string
  relayPath?: string
  socketFactory?: (url: string) => WebSocket
  handshakeTimeoutMs?: number
  onEvent: (event: AccountRelayEvent) => void
}

interface RelayFrame {
  type: string
  payload?: string
  online?: boolean
}

function relayUrl(path: string): string {
  const target = new URL(path, window.location.origin)
  target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:'
  return target.toString()
}

function parseFrame(value: string): RelayFrame | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    return {
      type: typeof record.type === 'string' ? record.type : '',
      payload: typeof record.payload === 'string' ? record.payload : undefined,
      online: typeof record.online === 'boolean' ? record.online : undefined
    }
  } catch {
    return null
  }
}

export function createAccountRelayClient(options: AccountRelayOptions): AccountRelayClient {
  const path = options.relayPath ?? '/v1/relay'
  const target = new URL(relayUrl(path))
  target.searchParams.set('role', 'mobile')
  target.searchParams.set('desktopId', options.desktopId)
  target.searchParams.set('mobileDeviceId', options.mobileDeviceId)
  const url = target.toString()
  const socketFactory = options.socketFactory ?? ((value: string) => new WebSocket(value))
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000
  let socket: WebSocket | null = null
  let open = false
  let settled = false
  let settle: (result: 'open' | 'offline' | 'failed') => void = () => undefined
  let timer: number | null = null

  function finish(result: 'open' | 'offline' | 'failed'): void {
    if (settled) return
    settled = true
    if (timer !== null) window.clearTimeout(timer)
    settle(result)
  }

  return {
    connect(): Promise<'open' | 'offline' | 'failed'> {
      socket = socketFactory(url)
      timer = window.setTimeout(() => {
        finish('failed')
        socket?.close()
      }, handshakeTimeoutMs)

      socket.onmessage = (event) => {
        if (typeof event.data !== 'string') return
        const frame = parseFrame(event.data)
        if (!frame) return
        if (frame.type === 'relay:authenticated') {
          if (frame.online !== true) {
            options.onEvent({ kind: 'offline' })
            finish('offline')
            socket?.close()
            return
          }
          open = true
          options.onEvent({ kind: 'connected', url })
          finish('open')
          return
        }
        if (frame.type === 'relay:data' && frame.payload) {
          void decryptPayload(options.controlSecret, frame.payload)
            .then((data) => options.onEvent({ kind: 'message', data }))
            .catch(() => {
              remoteLog.error('Cloud relay payload authentication failed')
              socket?.close()
            })
        }
      }
      socket.onclose = (event) => {
        const reason = event.reason || `relay-closed-${event.code}`
        if (!settled) finish('failed')
        if (open) options.onEvent({ kind: 'disconnected', reason })
        open = false
      }
      socket.onerror = () => {
        remoteLog.error('Cloud relay WebSocket failed')
      }

      return new Promise((resolve) => {
        settle = resolve
      })
    },

    async send(data: string): Promise<void> {
      if (!open || !socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Cloud relay is not connected')
      }
      const payload = await encryptPayload(options.controlSecret, data)
      socket.send(JSON.stringify({ type: 'relay:data', payload }))
    },

    close(): void {
      open = false
      socket?.close()
      socket = null
    }
  }
}
