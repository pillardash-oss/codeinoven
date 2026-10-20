import { spawn } from 'node:child_process'
import { Logger } from '../system/logger'
import { remoteServiceCommand } from './oven-remote-command'
import { remoteShell, type RemoteShell } from './oven-remote-shell'
import type { OvenSsh } from './oven-ssh'

/** How long one request may wait for its answer before the channel is replaced. */
const REQUEST_TIMEOUT_MS = 30_000
/** Consecutive start failures after which this Oven uses the one-request path. */
const START_FAILURES_BEFORE_FALLBACK = 2

/** Raised when the channel could not be started, so the caller can fall back. */
export class OvenChannelUnavailable extends Error {}

interface Pending {
  resolve: (value: string) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface Channel {
  child: ReturnType<typeof spawn>
  buffer: string
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

  constructor(private readonly ssh: OvenSsh) {}

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

  /** Send one request and resolve with the Oven's JSON answer. */
  async request(id: string, payload: string): Promise<string> {
    const channel = await this.acquire(id)
    return await new Promise<string>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: setTimeout(() => {
          // A channel that stopped answering is replaced rather than trusted
          // again: the next request starts a fresh one.
          this.drop(id, channel, 'The Oven did not answer in time.')
          reject(new Error('The Oven did not answer in time.'))
        }, REQUEST_TIMEOUT_MS)
      }
      channel.pending.push(pending)
      channel.child.stdin?.write(`${payload.trim()}\n`)
    })
  }

  /** Whether a channel is already open, without starting one. */
  isWarm(id: string): boolean {
    const channel = this.channels.get(id)
    return Boolean(channel && !channel.dead)
  }

  /** Close one Oven's channel, e.g. after it was removed or reconfigured. */
  dispose(id: string): void {
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
    const existing = this.channels.get(id)
    if (existing && !existing.dead) return existing
    const pending = this.starting.get(id)
    if (pending) return pending
    const start = this.start(id).finally(() => this.starting.delete(id))
    this.starting.set(id, start)
    return start
  }

  private async start(id: string): Promise<Channel> {
    const failures = this.startFailures.get(id) ?? 0
    if (failures >= START_FAILURES_BEFORE_FALLBACK)
      throw new OvenChannelUnavailable('The Oven channel could not be started.')
    let shell: RemoteShell
    try {
      shell = await remoteShell(this.ssh, id)
    } catch (error) {
      this.startFailures.set(id, failures + 1)
      throw new OvenChannelUnavailable(
        error instanceof Error ? error.message : 'The Oven did not answer.'
      )
    }
    const launch = await this.ssh.prepare(id, remoteServiceCommand(shell, ['attach']), false)
    const child = spawn(launch.executable, launch.args, {
      env: launch.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const channel: Channel = {
      child,
      buffer: '',
      stderr: '',
      pending: [],
      dead: false,
      dispose: launch.dispose
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (text: string) => {
      channel.buffer += text
      this.drain(channel)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (text: string) => {
      channel.stderr = `${channel.stderr}${text}`.slice(-4000)
    })
    child.on('error', (error: Error) => {
      this.startFailures.set(id, (this.startFailures.get(id) ?? 0) + 1)
      this.drop(id, channel, error.message)
    })
    child.on('exit', (code) => {
      const reason = channel.stderr.trim() || `The Oven channel closed (${code ?? 'no exit code'}).`
      this.drop(id, channel, reason)
    })
    const ready = await new Promise<Channel>((resolve, reject) => {
      const failed = (error: Error): void => reject(new OvenChannelUnavailable(error.message))
      child.once('error', failed)
      child.once('exit', () =>
        failed(new OvenChannelUnavailable(channel.stderr.trim() || 'The Oven channel closed.'))
      )
      // The channel is ready once the child is running: it answers requests in
      // order, so no probe round trip is needed to start using it.
      setImmediate(() => {
        child.off('error', failed)
        child.off('exit', failed)
        if (channel.dead) return
        resolve(channel)
      })
    })
    this.channels.set(id, channel)
    this.startFailures.set(id, 0)
    return ready
  }

  /** Match one buffered response line to the request waiting for it. */
  private drain(channel: Channel): void {
    for (;;) {
      const end = channel.buffer.indexOf('\n')
      if (end < 0) return
      const line = channel.buffer.slice(0, end).trim()
      channel.buffer = channel.buffer.slice(end + 1)
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
