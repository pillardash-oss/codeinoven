/**
 * Remote RPC protocol shared by the phone client and the desktop gateway.
 *
 * The phone PWA and the desktop renderer both speak the same `invoke` /
 * `subscribe` surface as the Electron IPC layer. Over the WebSocket bridge
 * that surface is carried as JSON frames wrapped in the existing AES-GCM
 * `remote:data` envelope, so every request/response is encrypted end to end.
 *
 * Frame shapes (payloads of `remote:data`, after decryption):
 *
 * - phone → desktop: `{ rpc: 'invoke', id, channel, args }`
 * - desktop → phone: `{ rpc: 'result', id, result }` | `{ rpc: 'error', id, message }`
 * - desktop → phone: `{ rpc: 'event', channel, payload }`
 *
 * `id` correlates an invoke to its result; events are pushed unsolicited. The
 * `RemoteInvokeChannel` union reuses the shared IPC channel contract so the
 * phone calls the exact same channels as the desktop renderer.
 */

export type RemoteRpcRequest = {
  rpc: 'invoke'
  id: number
  channel: string
  args: unknown[]
}

export type RemoteRpcResult = { rpc: 'result'; id: number; result: unknown }

export type RemoteRpcError = { rpc: 'error'; id: number; message: string }

export type RemoteRpcEvent = { rpc: 'event'; channel: string; payload: unknown }

export type RemoteRpcFrame = RemoteRpcRequest | RemoteRpcResult | RemoteRpcError | RemoteRpcEvent

/** Channels a phone client is allowed to invoke (a focused chat surface). */
export const REMOTE_ALLOWED_CHANNELS: readonly string[] = [
  'project:list',
  'project:get',
  'thread:listAll',
  'thread:list',
  'thread:get',
  'thread:create',
  'thread:markRead',
  'thread:setArchived',
  'thread:setPinned',
  'thread:setStatus',
  'thread:updateSettings',
  'thread:setContextUsage',
  'agent:loadMessages',
  'agent:listProviderSnapshot',
  'agent:getSessionStatus',
  'agent:ensureSession',
  'agent:sendPrompt',
  'agent:steerPrompt',
  'agent:abort',
  'agent:listPermissions',
  'agent:replyPermission',
  'agent:listQuestions',
  'agent:answerQuestion'
]

/** Channels the desktop pushes to the phone as live events. */
export const REMOTE_FORWARDED_EVENTS: readonly string[] = [
  'agent:event',
  'thread:updated',
  'providers:status'
] as const
