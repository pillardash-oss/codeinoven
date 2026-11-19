import type { ChildProcess } from 'node:child_process'

/**
 * Where Pi's JSONL RPC protocol travels.
 *
 * The client speaks exactly the same protocol to a local `pi --mode rpc` child
 * and to one running on a remote Oven, so it owns nothing but the framing of the
 * conversation: this seam carries one line in, whole lines and raw error text
 * out, and reports the peer's end exactly once. A transport does no protocol
 * work of its own   it never parses JSON, correlates ids, or filters records.
 */
export interface RpcTransport {
  /** Write one JSON line (the transport adds any framing it needs). */
  write(line: string): Promise<void>
  /** Raw stdout text, exactly as the peer decoded it. */
  onLine(handler: (line: string) => void): void
  onStderr(handler: (text: string) => void): void
  /** Exactly once, when the peer is gone. */
  onExit(handler: (code: number | null) => void): void
  /**
   * A peer-level failure, as the error that explains it (a launch error, a
   * broken channel). Optional: a transport that can only report that the peer
   * is gone says so through `onExit(null)` alone, and that is enough for the
   * client to fail every pending request.
   */
  onError?(handler: (error: Error) => void): void
  /** Terminate the peer; idempotent and never throws. */
  close(): Promise<void>
}

/** Time a local child gets to end on its own before it is killed. */
const CLOSE_GRACE_MS = 250

/**
 * The transport for a child this process spawned: it owns the newline framing
 * and forwards the child's own stdio, so the client never touches a stream.
 */
export function localRpcTransport(child: ChildProcess): RpcTransport {
  const lineHandlers: ((line: string) => void)[] = []
  const stderrHandlers: ((text: string) => void)[] = []
  const exitHandlers: ((code: number | null) => void)[] = []
  const errorHandlers: ((error: Error) => void)[] = []
  const exitWaiters: (() => void)[] = []
  let buffer = ''
  let exited = false
  let closing: Promise<void> | null = null

  const emitExit = (code: number | null): void => {
    if (exited) return
    exited = true
    for (const handler of exitHandlers) handler(code)
    for (const waiter of exitWaiters.splice(0)) waiter()
  }

  // Decoding at the stream rather than per chunk keeps a multi-byte character
  // that straddles two reads whole.
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/u)
    buffer = lines.pop() ?? ''
    for (const line of lines) for (const handler of lineHandlers) handler(line)
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    for (const handler of stderrHandlers) handler(chunk)
  })
  // Writing to a child that has already exited fails that write, and Node still
  // emits the stream's `error` event; without a listener that is an uncaught
  // exception thrown from the middle of an unrelated turn.
  child.stdin?.on('error', () => undefined)
  child.on('error', (error: Error) => {
    for (const handler of errorHandlers) handler(error)
    emitExit(null)
  })
  // A bundled Pi runs inside an Electron utility helper, which publishes `exit`
  // and has no OS stdio to close, so both events settle the peer   once.
  child.on('exit', (code: number | null) => emitExit(code))
  child.on('close', (code: number | null) => emitExit(code))

  const waitForExit = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(finish, ms)
      exitWaiters.push(finish)
    })

  const terminate = async (): Promise<void> => {
    if (!exited) {
      try {
        child.stdin?.end()
      } catch {
        // The stream was already gone; the grace period still decides whether
        // the child itself needs a signal.
      }
      if (!exited) await waitForExit(CLOSE_GRACE_MS)
    }
    if (exited || child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill()
    } catch {
      // Killing a child that has just gone is not an error for the caller.
    }
  }

  return {
    async write(line: string): Promise<void> {
      const stdin = child.stdin
      if (!stdin || stdin.destroyed || stdin.writableEnded || child.killed)
        throw new Error('Pi process is not running')
      await new Promise<void>((resolve, reject) => {
        stdin.write(`${line}\n`, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    onLine(handler: (line: string) => void): void {
      lineHandlers.push(handler)
    },
    onStderr(handler: (text: string) => void): void {
      stderrHandlers.push(handler)
    },
    onExit(handler: (code: number | null) => void): void {
      exitHandlers.push(handler)
    },
    onError(handler: (error: Error) => void): void {
      errorHandlers.push(handler)
    },
    close(): Promise<void> {
      closing ??= terminate()
      return closing
    }
  }
}
