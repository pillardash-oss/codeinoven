/**
 * Process entry point for a Pi session host.
 *
 * Phase 2 of the resource optimization workstream (see
 * `.cio/work/pi-session-host/plan.md`) launches this inside a utility process
 * and speaks the protocol in `protocol.ts` over its stdio. Until then the test
 * at `tests/main/drivers/pi-session-host.test.ts` exercises the same loop with
 * in-memory streams.
 *
 * Two transports on purpose. Under Electron's `utilityProcess` the host has no
 * stdin, only the parent port, so lines travel as messages; launched directly by
 * a probe or a script it speaks newline JSON on stdio. The protocol is the same
 * either way, and `run.ts` owns it.
 *
 * The host disposes every session when its input closes or it is signalled.
 */
import { PassThrough } from 'node:stream'
import { runSessionHost } from './run'

/** The slice of Electron's `ParentPort` this entry uses, without its types. */
interface HostParentPort {
  on(event: 'message', listener: (event: { data: unknown }) => void): void
  postMessage(message: string): void
  start?(): void
}

interface HostRuntime {
  stop(): void
  host: { dispose(): void }
}

function overParentPort(port: HostParentPort): HostRuntime {
  const input = new PassThrough()
  const output = new PassThrough()
  port.on('message', (event) => {
    const data = event?.data
    if (typeof data === 'string') input.write(`${data}\n`)
  })
  output.on('data', (chunk: Buffer) => port.postMessage(String(chunk)))
  port.start?.()
  const runtime = runSessionHost(input, output)
  return { stop: () => runtime.stop(), host: runtime.host }
}

function overStdio(): HostRuntime {
  const runtime = runSessionHost(process.stdin, process.stdout)
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  return { stop: () => runtime.stop(), host: runtime.host }
}

const parentPort = (process as NodeJS.Process & { parentPort?: HostParentPort }).parentPort
const runtime = parentPort === undefined ? overStdio() : overParentPort(parentPort)

let closing = false
function shutdown(): void {
  if (closing) return
  closing = true
  runtime.host.dispose()
  runtime.stop()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
