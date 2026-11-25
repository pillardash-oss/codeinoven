import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  OVEN_UTILITY_HOST_PROTOCOL,
  type OvenUtilityRelayCommand,
  type OvenUtilityRelayEvent
} from '../../../lib/oven-utility-host'
import { Logger } from '../../system/logger'
import { encodeRelayCommand, parseRelayEvent, RelayFrameReader } from './relay-frames'

/**
 * How long a relay may take to reach `ready`.
 *
 * Starting the service over SSH is slow on a cold Windows Oven, so this is
 * generous, but a turn must never wait forever on a machine that accepted the
 * connection and then said nothing.
 */
const RELAY_READY_TIMEOUT_MS = 60_000

/**
 * How long a relay gets to exit on its own after `stop`.
 *
 * `stop` asks the relay to unregister its turn from the Oven's host, and that is
 * a local HTTP call on the Oven, so anything longer means the child is wedged and
 * the pipe is better closed by signal.
 */
const RELAY_STOP_GRACE_MS = 2_000

/** How much of a failed relay's own stderr is kept for its failure message. */
const STDERR_TAIL_BYTES = 4_000

/** One call the Oven's host could not run there, exactly as it arrived. */
export type RelayAsk = Extract<OvenUtilityRelayEvent, { kind: 'ask' }>

/**
 * What one relay child needs from the registry that owns it.
 *
 * The child owns its pipe and nothing else: the registry decides which turn a
 * call belongs to and answers it, and it is the one that stops tracking a child
 * that is over. Both are callbacks rather than state so the child never has to
 * know how many relays exist or who else is using them.
 */
export interface RelayChildHost {
  /** One call this turn's harness cannot make on the Oven. */
  ask(child: RelayChild, call: RelayAsk): void
  /** The child is over, for a fault or because it was retired; forget it. */
  ended(child: RelayChild): void
}

/** What the registry knows about the child it is handing over. */
export interface RelayChildOptions {
  ovenId: string
  turnId: string
  sessionId: string
  child: ChildProcessWithoutNullStreams
  /** Removes the SSH invocation's private credentials once the child is gone. */
  dispose: () => Promise<void>
}

/** One wait for `ready`, settled by the frame or by the child's fate. */
interface RelayWaiter {
  resolve: (port: number) => void
  reject: (error: Error) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One relay child: its pipe, the frames on it, and the moment it is over.
 *
 * The child is the Oven's service in `utility-relay` mode, spawned over SSH with
 * a duplex pipe. It registers the turn with the Oven's own utility host and then
 * only forwards: `ready` names the port the turn's harness must use, every `ask`
 * is one call the host could not run on the Oven itself, and `failed` means the
 * turn is over.
 *
 * Nothing here is silent. A frame the contract cannot carry, a child that exits
 * early and a `failed` event all end the relay the same way: the wait for
 * `ready` is rejected, the failure is logged with the Oven's own stderr, the SSH
 * invocation is cleaned up, and the registry is told to forget this child.
 */
export class RelayChild {
  readonly ovenId: string
  readonly turnId: string
  readonly sessionId: string
  /** When it was requested, so a per-Oven cap can retire the oldest first. */
  readonly started = Date.now()

  private readonly frames = new RelayFrameReader()
  private readonly waiters: RelayWaiter[] = []
  /** Tail of the Oven's own stderr, for a failure message that means something. */
  private stderr = ''
  private port?: number
  private timer?: NodeJS.Timeout
  private dead = false
  private released = false

  constructor(
    private readonly host: RelayChildHost,
    private readonly options: RelayChildOptions
  ) {
    this.ovenId = options.ovenId
    this.turnId = options.turnId
    this.sessionId = options.sessionId
    this.watch(options.child)
    this.timer = setTimeout(() => {
      this.end('The Oven did not start its utility relay in time.')
    }, RELAY_READY_TIMEOUT_MS)
    this.timer.unref()
  }

  /** Whether this child can still carry calls for its turn. */
  alive(): boolean {
    return !this.dead
  }

  /** Wait for the port the Oven's host answers on. */
  whenReady(): Promise<number> {
    if (this.port !== undefined) return Promise.resolve(this.port)
    if (this.dead) return Promise.reject(new Error('The Oven utility relay closed.'))
    return new Promise<number>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }

  /** Write one command, ending the relay when the pipe refuses it. */
  send(command: OvenUtilityRelayCommand): void {
    if (this.dead) return
    let line: string
    try {
      line = encodeRelayCommand(command)
    } catch (error) {
      this.end(messageOf(error))
      return
    }
    this.options.child.stdin.write(line, (error: Error | null | undefined) => {
      if (error) this.end(error.message)
    })
  }

  /**
   * Ask the relay to unregister its turn, then end it if it does not go on its own.
   *
   * The host learns the turn is over before the pipe disappears, so it stops
   * holding a capability for a turn whose app has already let go of it.
   */
  retire(): void {
    if (this.dead) return
    this.dead = true
    this.clearTimer()
    this.frames.reset()
    for (const waiter of this.waiters.splice(0))
      waiter.reject(new Error('The Oven utility relay was retired.'))
    this.options.child.stdin.write(encodeRelayCommand({ kind: 'stop' }), () => undefined)
    this.options.child.stdin.end()
    const timer = setTimeout(() => {
      this.options.child.kill('SIGTERM')
      // A child that never reports its exit would otherwise keep this
      // connection's private credentials on disk.
      void this.release()
    }, RELAY_STOP_GRACE_MS)
    timer.unref()
    this.host.ended(this)
  }

  /** Follow the child: frames in, stderr and the end of the process out. */
  private watch(child: ChildProcessWithoutNullStreams): void {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => this.receive(text))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => {
      this.stderr = `${this.stderr}${text}`.slice(-STDERR_TAIL_BYTES)
    })
    child.on('error', (error: Error) => this.end(error.message))
    child.stdin.on('error', (error: Error) => this.end(error.message))
    child.on('close', (code: number | null) => this.closed(code))
  }

  /** Read one chunk of frames, ending the relay on a frame it cannot carry. */
  private receive(text: string): void {
    let frames: string[]
    try {
      frames = this.frames.push(text)
    } catch (error) {
      this.end(messageOf(error))
      return
    }
    for (const frame of frames) this.frame(frame)
  }

  /** Act on one frame the relay sent. */
  private frame(raw: string): void {
    if (this.dead) return
    let event: OvenUtilityRelayEvent
    try {
      event = parseRelayEvent(raw)
    } catch (error) {
      this.end(messageOf(error))
      return
    }
    if (event.kind === 'ready') return this.opened(event)
    if (event.kind === 'failed') return this.end(event.error)
    // A relay serves exactly one turn, so a frame naming another one is a peer
    // this app cannot trust: answering it would widen a grant the app issued.
    if (event.turnId !== this.turnId)
      return this.end('The Oven utility relay forwarded a call for another turn.')
    this.host.ask(this, event)
  }

  /** Point this turn's harness at the host the relay reached. */
  private opened(event: { hostProtocolVersion: number; port: number }): void {
    if (event.hostProtocolVersion !== OVEN_UTILITY_HOST_PROTOCOL) {
      this.end(
        `The Oven utility host speaks protocol ${event.hostProtocolVersion}, but this app speaks ${OVEN_UTILITY_HOST_PROTOCOL}. Install the current service on this Oven.`
      )
      return
    }
    this.clearTimer()
    this.port = event.port
    for (const waiter of this.waiters.splice(0)) waiter.resolve(event.port)
    Logger.info('The Oven utility relay is ready', {
      ovenId: this.ovenId,
      turnId: this.turnId,
      sessionId: this.sessionId,
      port: event.port
    })
  }

  /** End this relay for a fault: report it, reject the wait, and kill the child. */
  private end(reason: string): void {
    if (this.dead) return
    this.dead = true
    this.clearTimer()
    this.frames.reset()
    Logger.error('The Oven utility relay failed', {
      ovenId: this.ovenId,
      turnId: this.turnId,
      sessionId: this.sessionId,
      error: reason
    })
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(reason))
    this.options.child.stdin.end()
    this.options.child.kill('SIGTERM')
    this.host.ended(this)
  }

  /** The child is gone: report a failure that was not asked for, then clean up. */
  private closed(code: number | null): void {
    this.clearTimer()
    if (!this.dead) {
      const tail = this.stderr
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(-3)
        .join(' · ')
      this.end(
        tail
          ? `The Oven utility relay closed: ${tail.slice(0, 300)}`
          : `The Oven utility relay closed (${code ?? 'no exit code'}).`
      )
    }
    void this.release()
  }

  /** Clean the SSH invocation once, whichever path ended the child. */
  private async release(): Promise<void> {
    if (this.released) return
    this.released = true
    try {
      await this.options.dispose()
    } catch (error) {
      Logger.dev('Oven utility relay credential cleanup failed', {
        ovenId: this.ovenId,
        error: messageOf(error)
      })
    }
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}
