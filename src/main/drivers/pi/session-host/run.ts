/**
 * Newline-delimited JSON loop for a Pi session host.
 *
 * Kept separate from `entry.ts` so tests can drive the host over in-memory
 * streams without spawning a process.
 */
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import { PiSessionHost } from './session-host'
import { parseHostRequestLine } from './protocol'

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
    const request = parseHostRequestLine(trimmed)
    if (request === null) {
      output.write(
        `${JSON.stringify({
          type: 'host_notice',
          level: 'error',
          message: 'Unparseable request line'
        })}\n`
      )
      return
    }
    void host.handle(request)
  })
  return { host, stop: () => reader.close() }
}
