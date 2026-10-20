import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { OVEN_PROTOCOL_VERSION } from '../../lib/ovens'
import { Logger } from '../system/logger'
import { remoteServiceCommand } from './oven-remote-command'
import { remoteShell } from './oven-remote-shell'
import type { OvenSsh } from './oven-ssh'

/** How long one request may wait for its answer before the channel is replaced. */
const REQUEST_TIMEOUT_MS = 30_000
/**
 * The largest single answer the channel accepts.
 *
 * A file read carries a file's contents, so the bound matches the size a
 * `root-operation` may return. It exists to keep one wedged Oven from growing
 * this app's memory without limit, not to shorten a normal answer.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
/** Consecutive start failures after which this Oven uses the one-request path. */
const START_FAILURES_BEFORE_FALLBACK = 2

/** Raised when the channel could not be started, so the caller can fall back. */
export class OvenChannelUnavailable extends Error {}

/**
 * Raised when the Oven answers from a service bundle this app did not install.
 *
 * The channel carries operations the older bundles do not know (a file action
 * arrives as one `root-operation` line), so this app replaces that service
 * before it sends work it cannot answer. It is deliberately not a channel
 * failure: the connection is healthy, the bundle is old.
 */
export class OvenServiceOutdated extends Error {}

interface Pending {
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Channel {
  child: ReturnType<typeof spawn>
  /** Chunks of one answer that has not reached its newline yet. */
  parts: string[]
  /** Bytes buffered in `parts`, so a huge answer is refused instead of kept. */
  bytes: number
  /** Tail of the Oven's own stderr, for a failure message that means something. */
  stderr: string
  pending: Pending[]
  dead: boolean
  dispose: () => Promise<void>
}

/**
 * One long-lived request channel per Oven.
 *
 * Every request used to be a fresh SSH invocation that started `node` on the
 * Oven, which costs seconds on Windows before the request is even read, and the
 * app makes several requests per screen. This keeps a single `attach` process
 * alive per Oven and pipelines requests over its stdin, so a request costs a
 * round trip. It starts when the Oven is first used, before any request that
 * needs it, so the Oven is warm by the time a file tree or a prompt asks.
 *
 * Failure is never silent and never lost: the child's stderr is kept for the
 * message, every in-flight request is rejected when it dies, and a channel that
 * cannot start twice in a row makes the caller use the one-request path instead.
 */
export class OvenRequestChannel {
  private readonly channels = new Map<string, Channel>()
  private readonly starting = new Map<string, Promise<Channel>>()
  private readonly startFailures = new Map<string, number>()
  private disposed = false

  /**
   * @param serviceRevision The revision of the bundle this app is built with.
   *   The startup probe reports the revision the Oven is actually running, and a
   *   different one means its service predates the operations sent over this
   *   channel.
   */
  constructor(
    private readonly ssh: OvenSsh,
    private readonly serviceRevision: () => Promise<string>
  ) {}

  /**
   * Start the channel for one Oven before anything needs it.
   *
   * Called wherever the user points the app at an Oven (opening its settings, the
   * composer's Oven picker, the default switch), so the first real request does
   * not pay for process startup.
   */
  async warm(id: string): Promise<void> {
    try {
      await this.acquire(id)
    } catch (error) {
      Logger.dev('Oven channel could not be warmed', {
        ovenId: id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Send one request and resolve with the Oven's JSON answer.
   *
   * `timeoutMs` lets an operation that legitimately runs long (a Git command on a
   * large checkout) wait without being mistaken for a wedged channel.
   */
  async request(id: string, payload: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<string> {
    const channel = await this.acquire(id)
    return this.send(id, channel, payload, timeoutMs)
  }

  private send(id: string, channel: Channel, payload: string, timeoutMs: number): Promise<string> {
    if (channel.dead) return Promise.reject(new Error('The Oven channel closed.'))
    return new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // A channel that stopped answering is replaced rather than trusted
          // again: the next request starts a fresh one.
          this.drop(id, channel, 'The Oven did not answer in time.')
          reject(new Error('The Oven did not answer in time.'))
        }, timeoutMs)
      }
      channel.pending.push(pending)
      channel.child.stdin?.write(`${payload.trim()}\n`, (error) => {
        if (error) this.drop(id, channel, error.message)
      })
    })
  }

  /** Whether a channel is already open, without starting one. */
  isWarm(id: string): boolean {
    const channel = this.channels.get(id)
    return Boolean(channel && !channel.dead && !this.starting.has(id))
  }

  /** Close one Oven's channel, e.g. after it was removed or reconfigured. */
  dispose(id: string): void {
    this.startFailures.delete(id)
    const channel = this.channels.get(id)
    if (channel) this.drop(id, channel, 'The Oven channel closed.')
  }

  /** Close every channel, as the app does on quit. */
  disposeAll(): void {
    this.disposed = true
    for (const [id, channel] of [...this.channels]) this.drop(id, channel, 'The app is closing.')
  }

  private async acquire(id: string): Promise<Channel> {
    if (this.disposed) throw new OvenChannelUnavailable('The app is closing.')
    const pending = this.starting.get(id)
    if (pending) return pending
    const existing = this.channels.get(id)
    if (existing && !existing.dead) return existing
    const failures = this.startFailures.get(id) ?? 0
    if (failures >= START_FAILURES_BEFORE_FALLBACK)
      throw new OvenChannelUnavailable('The Oven channel could not be started.')
    const start = this.start(id)
      .catch((error: unknown) => {
        // An outdated bundle is not a broken channel: counting it would retire a
        // connection that works and is about to be replaced.
        if (error instanceof OvenServiceOutdated) throw error
        this.startFailures.set(id, failures + 1)
        throw new OvenChannelUnavailable(
          error instanceof Error ? error.message : 'The Oven did not answer.'
        )
      })
      .finally(() => this.starting.delete(id))
    this.starting.set(id, start)
    return start
  }

  private async start(id: string): Promise<Channel> {
    const shell = await remoteShell(this.ssh, id)
    const launch = await this.ssh.prepare(id, remoteServiceCommand(shell, ['attach']), false)
    if (this.disposed) {
      await launch.dispose()
      throw new Error('The app is closing.')
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(launch.executable, launch.args, {
        env: launch.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch (error) {
      await launch.dispose()
      throw error
    }
    const channel: Channel = {
      child,
      parts: [],
      bytes: 0,
      stderr: '',
      pending: [],
      dead: false,
      dispose: launch.dispose
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => {
      this.receive(id, channel, text)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => {
      channel.stderr = `${channel.stderr}${text}`.slice(-4000)
    })
    child.on('error', (error: Error) => {
      this.drop(id, channel, error.message)
    })
    child.stdin?.on('error', (error: Error) => this.drop(id, channel, error.message))
    child.on('exit', (code) => {
      const reason = channel.stderr.trim() || `The Oven channel closed (${code ?? 'no exit code'}).`
      this.drop(id, channel, reason)
    })
    // Track startup too, so closing an Oven or quitting cancels its probe.
    this.channels.set(id, channel)
    try {
      // Spawning SSH does not prove that the installed bundle supports attach.
      // Older bundles print an error and exit. Probe before sending user work,
      // so falling back never repeats a run or another mutating request.
      const output = await this.send(
        id,
        channel,
        JSON.stringify({ method: 'probe', protocolVersion: OVEN_PROTOCOL_VERSION }),
        REQUEST_TIMEOUT_MS
      )
      const response = JSON.parse(output.replace(/^\uFEFF/u, '')) as {
        ok?: boolean
        error?: string
        value?: { serviceRevision?: unknown }
      }
      if (response.ok !== true)
        throw new Error(response.error || 'The Oven channel did not answer its startup probe.')
      const running = response.value?.serviceRevision
      if (typeof running === 'string') {
        const expected = await this.serviceRevision().catch(() => null)
        if (expected && running !== expected)
          throw new OvenServiceOutdated('The Oven is running an older service.')
      }
      if (this.disposed || channel.dead) throw new Error('The Oven channel closed.')
    } catch (error) {
      this.drop(id, channel, error instanceof Error ? error.message : 'The Oven channel closed.')
      throw error
    }
    this.startFailures.set(id, 0)
    return channel
  }

  /**
   * Accept one stdout chunk, answering every complete line it finishes.
   *
   * Answers are joined from their chunks instead of being appended to one
   * growing string: a file read arrives as many chunks, and re-concatenating on
   * each one made a large answer cost quadratic memory before it was parsed.
   */
  private receive(id: string, channel: Channel, text: string): void {
    let rest = text
    for (;;) {
      const end = rest.indexOf('\n')
      if (end < 0) {
        if (rest) {
          channel.parts.push(rest)
          channel.bytes += Buffer.byteLength(rest)
          if (channel.bytes > MAX_RESPONSE_BYTES) {
            this.drop(id, channel, 'The Oven answer exceeded the size limit.')
          }
        }
        return
      }
      const head = rest.slice(0, end)
      const line = (channel.parts.length ? `${channel.parts.join('')}${head}` : head).trim()
      channel.parts.length = 0
      channel.bytes = 0
      rest = rest.slice(end + 1)
      if (!line) continue
      const pending = channel.pending.shift()
      if (!pending) continue
      clearTimeout(pending.timer)
      pending.resolve(line)
    }
  }

  /** Forget one channel and reject everything still waiting on it. */
  private drop(id: string, channel: Channel, reason: string): void {
    if (channel.dead) return
    channel.dead = true
    channel.parts.length = 0
    channel.bytes = 0
    if (this.channels.get(id) === channel) this.channels.delete(id)
    for (const pending of channel.pending.splice(0)) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    channel.child.stdin?.end()
    channel.child.kill('SIGTERM')
    void channel.dispose().catch(() => Logger.dev('Oven channel credential cleanup failed'))
  }
}
