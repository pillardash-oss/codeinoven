/**
 * Phone PWA `window.api` shim.
 *
 * The existing renderer stores (thread messages, provider catalog, settings,
 * workspace) read IPC through `window.api` (the Electron preload bridge). On
 * the phone there is no preload, so the PWA installs a compatible shim that
 * routes every `invoke`/`on` call over the encrypted remote WebSocket bridge to
 * the desktop gateway. This lets the whole desktop chat stack run unchanged on
 * the phone.
 */

import type { AppBridge } from '../../../preload/index'
import type { AttachmentStorageScope } from '$shared/types'
import { remoteBridge } from './remote-bridge'

const REMOTE_UPLOAD_CHUNK_BYTES = 192 * 1024
const MAX_REMOTE_ATTACHMENT_BYTES = 32 * 1024 * 1024

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768))
  }
  return btoa(binary)
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function isConnectionInterruption(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  return (
    message.includes('desktop connection changed') ||
    message.includes('not connected to the desktop') ||
    message.includes('socket')
  )
}

async function uploadRemoteFile(file: File, scope: AttachmentStorageScope): Promise<string> {
  const uploadId = await remoteBridge.invoke(
    'attachment:beginRemoteUpload',
    scope,
    file.name,
    file.size
  )
  if (typeof uploadId !== 'string') throw new Error('The desktop did not start the upload')
  let offset = 0
  try {
    while (offset < file.size) {
      const bytes = new Uint8Array(
        await file.slice(offset, offset + REMOTE_UPLOAD_CHUNK_BYTES).arrayBuffer()
      )
      const received = await remoteBridge.invoke(
        'attachment:appendRemoteUpload',
        uploadId,
        offset,
        bytesToBase64(bytes)
      )
      if (typeof received !== 'number' || received <= offset) {
        throw new Error('The desktop rejected an attachment chunk')
      }
      offset = received
    }
    const path = await remoteBridge.invoke('attachment:finishRemoteUpload', uploadId)
    return typeof path === 'string' ? path : ''
  } catch (error) {
    await remoteBridge.invoke('attachment:cancelRemoteUpload', uploadId).catch(() => undefined)
    throw error
  }
}

async function registerRemoteFile(file: File, scope?: AttachmentStorageScope): Promise<string> {
  if (!scope) return ''
  if (file.size === 0) throw new TypeError('Dropped attachment is empty')
  if (file.size > MAX_REMOTE_ATTACHMENT_BYTES) {
    throw new TypeError('Dropped browser attachment must be at most 32 MB')
  }
  try {
    return await uploadRemoteFile(file, scope)
  } catch (error) {
    // Camera/gallery pickers suspend the PWA. Keep the returned File alive and
    // retry the whole bounded upload after the desktop transport is restored.
    if (!isConnectionInterruption(error)) throw error
    return uploadRemoteFile(file, scope)
  }
}

async function readRemoteFile(path: string): Promise<Uint8Array<ArrayBuffer>> {
  let offset = 0
  let bytes: Uint8Array<ArrayBuffer> | undefined

  while (bytes === undefined || offset < bytes.byteLength) {
    const result = await remoteBridge.invoke('attachment:readRemoteChunk', path, offset)
    if (typeof result !== 'object' || result === null) {
      throw new Error('The desktop returned an invalid attachment response')
    }
    const record = result as Record<string, unknown>
    const { base64, nextOffset, size } = record
    if (
      typeof base64 !== 'string' ||
      typeof nextOffset !== 'number' ||
      !Number.isSafeInteger(nextOffset) ||
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_REMOTE_ATTACHMENT_BYTES
    ) {
      throw new Error('The desktop returned invalid attachment metadata')
    }
    if (bytes === undefined) bytes = new Uint8Array(size)
    if (size !== bytes.byteLength || nextOffset <= offset || nextOffset > size) {
      throw new Error('The desktop returned an out-of-order attachment chunk')
    }

    const chunk = base64ToBytes(base64)
    if (chunk.byteLength !== nextOffset - offset) {
      throw new Error('The desktop returned an incomplete attachment chunk')
    }
    bytes.set(chunk, offset)
    offset = nextOffset
  }

  return bytes
}

declare global {
  interface Window {
    api: AppBridge
  }
}

export function installRemoteApiShim(): void {
  if (typeof window === 'undefined') return
  if ('api' in window) return

  const bridge: AppBridge = {
    invoke: ((channel: string, ...args: unknown[]) =>
      remoteBridge.invoke(channel, ...args)) as AppBridge['invoke'],
    send: () => undefined,
    on: ((channel: string, callback: (...args: unknown[]) => void) =>
      remoteBridge.on(channel, callback)) as AppBridge['on'],
    config: {
      get: async () => ({}) as never,
      update: async () => ({}) as never
    } as AppBridge['config'],
    windowInfo: {
      platform: 'linux',
      trafficLight: { present: false, side: null, offset: 0 }
    },
    readFile: readRemoteFile,
    registerFileSelection: registerRemoteFile,
    getPathForFile: () => '',
    startFileDrag: () => {}
  }

  ;(window as Window & { api?: AppBridge }).api = bridge
}
