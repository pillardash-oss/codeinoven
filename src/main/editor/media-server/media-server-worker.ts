/**
 * The loopback file server for media previews, running in its own worker thread.
 *
 * Audio and video are the one kind of preview the reader streams for minutes at
 * a time, and the bytes used to be pumped through the Electron main process:
 * `appfile://` answered every range request with a Node read stream bridged into
 * a web stream, so each chunk crossed the main thread's event loop. Measured
 * over 288 MiB of range requests, that cost the main process ~470 ms of extra
 * CPU compared with serving the same file from a worker thread, and the marginal
 * latency appeared in the main thread's own 10 ms watchdog. A worker thread has
 * no such coupling: reads, range framing and socket writes all happen here, and
 * the main process only answers the protocol request with a redirect.
 *
 * Nothing is reachable without a grant from the main process, the listener is
 * bound to loopback, and every URL carries the per-process token. A file is
 * opened with `O_NOFOLLOW` and streamed from its own range, so a sweep of large
 * files never loads one into memory.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { byteRange, previewHeaders } from '../../../lib/preview-range'
import type { MediaServerEvent, MediaServerGrant, MediaServerUpdate } from './media-server-protocol'

const port = parentPort
const token: string = (workerData as { token: string }).token
const grants = new Map<string, MediaServerGrant>()
/** Responses in flight; the controller will not stop the worker while any is open. */
let active = 0

function send(event: MediaServerEvent): void {
  port?.postMessage(event)
}

function fail(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
  response.end(message)
}

async function serve(request: IncomingMessage, response: ServerResponse, grant: MediaServerGrant) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' })
    response.end()
    return
  }

  const handle = await open(grant.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1) {
      await handle.close()
      fail(response, 404, 'Not found')
      return
    }
    const range = byteRange(request.headers.range ?? null, metadata.size)
    if (!range) {
      await handle.close()
      response.writeHead(416, { 'Content-Range': `bytes */${metadata.size}` })
      response.end()
      return
    }
    const contentLength = range.end - range.start + 1
    const headers = previewHeaders(grant, contentLength)
    const partial = request.headers.range !== undefined
    if (partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`)
    for (const [name, value] of headers) response.setHeader(name, value)
    if (request.method === 'HEAD') {
      await handle.close()
      response.writeHead(partial ? 206 : 200)
      response.end()
      return
    }
    response.writeHead(partial ? 206 : 200)
    const stream = handle.createReadStream({ start: range.start, end: range.end, autoClose: true })
    active += 1
    send({ type: 'busy', active })
    response.on('close', () => {
      // A reader that navigates away cancels the response; the file handle must
      // not outlive it.
      stream.destroy()
      active -= 1
      send({ type: 'busy', active })
    })
    stream.on('error', () => response.destroy())
    stream.pipe(response)
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.searchParams.get('token') !== token) {
    fail(response, 403, 'Forbidden')
    return
  }
  const id = url.pathname.startsWith('/media/') ? url.pathname.slice('/media/'.length) : ''
  const grant = grants.get(id)
  if (!grant) {
    fail(response, 404, 'Not found')
    return
  }
  send({ type: 'served' })
  void serve(request, response, grant).catch((error: unknown) => {
    if (!response.headersSent) fail(response, 404, 'Not found')
    else response.destroy()
    send({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  })
})

server.on('error', (error) => send({ type: 'failed', message: error.message }))

port?.on('message', (update: MediaServerUpdate) => {
  if (update.type === 'grant') {
    grants.set(update.grant.id, update.grant)
    return
  }
  if (update.type === 'stop') {
    server.close()
    port.close()
  }
})

server.listen(0, '127.0.0.1', () => {
  send({ type: 'ready', port: (server.address() as AddressInfo).port })
})
