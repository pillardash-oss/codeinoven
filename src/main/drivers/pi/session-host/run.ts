/**
 * Newline-delimited JSON loop for a Pi session host.
 *
 * Kept separate from `entry.ts` so tests can drive the host over in-memory
 * streams without spawning a process.
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { PiSessionHost } from './session-host'
import { parseHostLine, type HostResponseEnvelope } from './protocol'

export interface SessionHostRuntime {
  readonly host: PiSessionHost
  /** Stop reading input. Hosted sessions stay alive until `host.dispose()`. */
  stop(): void
}

export function runSessionHost(input: Readable, output: Writable): SessionHostRuntime {
  const host = new PiSessionHost((line) => {
    output.write(`${JSON.stringify(line)}\n`)
  })
  const reader = createInterface({ input, crlfDelay: Infinity })
  reader.on('line', (line) => {
    const trimmed = line.trim()
    if (trimmed.length === 0) return
    const parsed = parseHostLine(trimmed)
    if (parsed.status === 'rejected') {
      if (parsed.id !== null) {
        const response: HostResponseEnvelope = {
          type: 'response',
          id: parsed.id,
          ...(parsed.sessionId === null ? {} : { sessionId: parsed.sessionId }),
          ok: false,
          error: parsed.error
        }
        output.write(`${JSON.stringify(response)}\n`)
        return
      }
      output.write(
        `${JSON.stringify({
          type: 'host_notice',
          level: 'error',
          message: parsed.error
        })}\n`
      )
      return
    }
    void host.handle(parsed.request)
  })
  return { host, stop: () => reader.close() }
}
