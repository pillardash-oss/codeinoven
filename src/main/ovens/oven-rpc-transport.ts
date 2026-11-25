import type { OvenRun, OvenRunEvent } from '../../lib/ovens'
import type { RpcTransport } from '../drivers/pi-rpc-transport'

/**
 * The Oven service calls this transport needs, spelled structurally so the
 * desktop client (`OvenService`) satisfies it as it stands.
 */
export interface OvenRunService {
  write(ovenId: string, runId: string, input: string, closeInput?: boolean): Promise<void>
  events(
    ovenId: string,
    runId: string,
    after: number
  ): Promise<{ run: OvenRun; events: OvenRunEvent[] }>
  stop(ovenId: string, runId: string): Promise<void>
}

export interface OvenRpcTransportInput {
  service: OvenRunService
  ovenId: string
  runId: string
  /** Delay between journal polls while the run is idle. */
  pollMs?: number
}

/** Fast enough that a turn's first token is not visibly late. */
const DEFAULT_POLL_MS = 120

/**
 * A transport for a Pi child running on an Oven.
 *
 * The Oven keeps the child's stdio in a journal and exposes it through `events`
 * pages, so this transport turns that pull into a push: one polling loop reads
 * from a cursor, splits the journal's stdout text back into the lines Pi wrote,
 * and ends exactly where the run does. Writes go the other way through the
 * service's `write`, one at a time so two lines can never interleave inside a
 * single request.
 */
export function ovenRpcTransport(input: OvenRpcTransportInput): RpcTransport {
  const pollMs = Math.max(1, Math.floor(input.pollMs ?? DEFAULT_POLL_MS))
  const lineHandlers: ((line: string) => void)[] = []
  const stderrHandlers: ((text: string) => void)[] = []
  const exitHandlers: ((code: number | null) => void)[] = []
  let buffer = ''
  let cursor = 0
  let exited = false
  let closed = false
  let polling = false
  let wake: (() => void) | null = null
  let writes: Promise<void> = Promise.resolve()
  let closing: Promise<void> | null = null

  const emitExit = (code: number | null): void => {
    if (exited) return
    exited = true
    for (const handler of exitHandlers) handler(code)
  }

  /** One stdout chunk, split into whole lines the way a pipe would deliver them. */
  const deliver = (text: string): void => {
    buffer += text
    const lines = buffer.split(/\r?\n/u)
    buffer = lines.pop() ?? ''
    for (const line of lines) for (const handler of lineHandlers) handler(line)
  }

  /** A poll delay that `close()` can cut short instead of waiting it out. */
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        if (timer !== null) clearTimeout(timer)
        wake = null
        resolve()
      }
      timer = setTimeout(finish, ms)
      wake = finish
    })

  const poll = async (): Promise<void> => {
    // Sequential by construction: the loop awaits each page before asking for
    // the next one, so two polls never read the same cursor range.
    while (!closed) {
      let page: { run: OvenRun; events: OvenRunEvent[] }
      try {
        page = await input.service.events(input.ovenId, input.runId, cursor)
      } catch {
        // A lost channel (SSH dropped, service restarted) has to end the peer
        // the client knows: nobody is left to answer its pending requests. It
        // is reported, not thrown, because this loop has no caller to catch it.
        emitExit(null)
        return
      }
      for (const event of page.events) {
        if (event.sequence <= cursor) continue
        cursor = event.sequence
        if (event.stream === 'stdout') deliver(event.text)
        else if (event.stream === 'stderr')
          for (const handler of stderrHandlers) handler(event.text)
        // An `exit` record only restates the run's own status, which ends the
        // loop below, so nothing is emitted from the journal here.
      }
      if (closed) return
      if (page.run.status !== 'running') {
        emitExit(page.run.exitCode ?? null)
        return
      }
      // A full page means more is already waiting; anything less means the Oven
      // has nothing new, so the loop waits instead of spinning on an idle run.
      if (page.events.length > 0) continue
      await sleep(pollMs)
    }
  }

  const start = (): void => {
    if (polling || closed || exited) return
    polling = true
    void poll()
  }

  const write = (line: string): Promise<void> => {
    const queued = writes.then(async () => {
      if (closed || exited) throw new Error('The Oven run is no longer accepting input')
      await input.service.write(input.ovenId, input.runId, `${line}\n`)
    })
    // The queue survives a failed write so the next line is not blocked by it;
    // the failure itself reaches the caller through the returned promise.
    writes = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  return {
    write,
    onLine(handler: (line: string) => void): void {
      lineHandlers.push(handler)
      start()
    },
    onStderr(handler: (text: string) => void): void {
      stderrHandlers.push(handler)
      start()
    },
    onExit(handler: (code: number | null) => void): void {
      exitHandlers.push(handler)
      start()
    },
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true
        wake?.()
        try {
          await input.service.stop(input.ovenId, input.runId)
        } catch {
          // The run is already gone, or the channel is down. The caller asked
          // to be through with the peer, not to learn why stopping it failed.
        }
      })()
      return closing
    }
  }
}
