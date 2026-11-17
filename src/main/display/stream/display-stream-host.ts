/**
 * The device stream, hosted in an Electron `utilityProcess` of its own (forked by
 * `display-stream-process.ts` through the electron-vite `?modulePath` import).
 *
 * It exists so that nothing on the hot path touches the main process: video packets
 * leave this process on a `MessagePort` that goes straight to the renderer, and
 * pointer events come back the same way. The main process only hears two short
 * lifecycle messages (`live`, `ended`) on the parent port.
 */
import {
  isStreamInbound,
  isStreamStart,
  type StreamInbound,
  type StreamOutbound
} from '../../../lib/display-stream-protocol'
import { AndroidScrcpyStream } from './android-scrcpy-stream'

interface HostPort {
  postMessage: (message: unknown) => void
  on: (
    event: 'message',
    listener: (message: { data: unknown; ports: HostPort[] }) => void
  ) => unknown
  once: (
    event: 'message',
    listener: (message: { data: unknown; ports: HostPort[] }) => void
  ) => unknown
  start?: () => void
  close?: () => void
}

const parent = (process as NodeJS.Process & { parentPort?: HostPort }).parentPort

function route(stream: AndroidScrcpyStream, message: StreamInbound): void {
  switch (message.type) {
    case 'pointer':
      stream.pointer(message)
      return
    case 'key':
      stream.key(message)
      return
    case 'text':
      stream.text(message)
      return
    case 'scroll':
      stream.scroll(message)
      return
    case 'control':
      stream.controlButton(message)
      return
    case 'abort':
      stream.stop()
      // The renderer already knows why it aborted, but the main process is what puts
      // the panel back on the polled capture, so this message must be delivered
      // before the process that would send it goes away.
      parent?.postMessage({ type: 'ended', detail: message.reason })
      setTimeout(() => process.exit(0), 50)
  }
}

parent?.once('message', (event) => {
  const [port] = event.ports
  if (!port || !isStreamStart(event.data)) {
    process.exit(1)
    return
  }
  const start = event.data
  let live = false
  const send = (message: StreamOutbound): void => {
    port.postMessage(message)
    if (message.type !== 'state') return
    if (message.phase === 'live' && !live) {
      live = true
      parent.postMessage({ type: 'live' })
    }
    if (message.phase === 'ended') {
      parent.postMessage({ type: 'ended', detail: message.detail ?? null, wasLive: live })
      // The renderer has the final state; give the port a tick to deliver it.
      setTimeout(() => process.exit(0), 50)
    }
  }
  const stream = new AndroidScrcpyStream({
    adb: start.adb,
    serial: start.serial,
    serverPath: start.serverPath,
    maxSize: start.maxSize,
    send
  })
  port.on('message', (input) => {
    if (isStreamInbound(input.data)) route(stream, input.data)
  })
  // The main process asks for a clean stop so the device's server and the adb
  // forward are removed instead of being left for the next stream to find.
  parent.on('message', (control) => {
    const data = control.data
    if (typeof data === 'object' && data !== null && 'type' in data && data.type === 'stop') {
      stream.stop()
      setTimeout(() => process.exit(0), 150)
    }
  })
  port.start?.()
  send({ type: 'state', phase: 'starting' })
  stream.start().catch((error: unknown) => {
    stream.stop()
    send({
      type: 'state',
      phase: 'ended',
      detail: error instanceof Error ? error.message : String(error)
    })
  })
})
