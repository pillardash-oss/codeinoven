import { spawn, type ChildProcess } from 'node:child_process'
import type { PreparedHarnessInvocation } from './harness-runtime'
import { spawnInUtilityHost } from './harness-utility-host'
import { PI_COMPACTION_EXTENSION_KEY } from './pi-compaction-extension'
import { localRpcTransport, type RpcTransport } from './pi-rpc-transport'

/**
 * A single Pi image content block, sent with a prompt or steer message.
 */
export interface PiRpcImage {
  type: 'image'
  data: string
  mimeType: string
}

interface PendingRequest {
  compacting: boolean
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface PiRpcCommonOptions {
  /** Called once per agent event record streamed from the pi process. */
  onEvent?: (record: Record<string, unknown>) => void
  /** Called for dialog-style extension UI requests that need a human answer. */
  onUiRequest?: (record: Record<string, unknown>) => void
  /**
   * Called for fire-and-forget extension UI records (setStatus/setWidget/
   * notify/setTitle) that carry state without expecting a reply.
   */
  onExtensionStatus?: (record: Record<string, unknown>) => void
  /** Called once when the pi process exits unexpectedly. */
  onExit?: (code: number | null) => void
}

/**
 * Where the client's peer comes from.
 *
 * A local run leaves the transport out and the client spawns the prepared
 * invocation itself; a run whose peer already exists (an Oven) passes only the
 * transport that carries the same JSON lines to it. `transport` wins when both
 * are given, which is what keeps a caller that has a prepared invocation on
 * hand and decides to route it elsewhere working.
 */
type PiRpcOptions = PiRpcCommonOptions &
  (
    | { invocation: PreparedHarnessInvocation; transport?: RpcTransport }
    | { invocation?: undefined; transport: RpcTransport }
  )

const REQUEST_TIMEOUT_MS = 120_000
/** A page checkpoint can take several requests; bound idle time between batches. */
const COMPACTION_IDLE_TIMEOUT_MS = 300_000

/**
 * Minimal JSONL RPC client for `pi --mode rpc` (installed on the user's PATH).
 *
 * Pi's headless RPC mode accepts JSON commands on stdin and emits JSON events
 * plus `{ type: "response" }` records on stdout. This client correlates
 * responses by their `id`, forwards agent events to a callback, and answers
 * Pi's extension UI requests so the agent never blocks on an unattended dialog.
 *
 * It reaches Pi through an {@link RpcTransport}: by default it spawns the `pi`
 * child itself, and a caller that already has a peer (a run on an Oven) passes
 * the transport that carries the same lines to it. Nothing above the transport
 * knows which of the two it is talking to.
 *
 * The driver keeps this in-process only to speak the protocol; the actual agent
 * runs in the `pi` binary the user installs, mirroring how Claude Code is used.
 */
export class PiRpcClient {
  /** The spawned child, or null when the caller supplied its own transport. */
  private readonly child: ChildProcess | null
  private readonly transport: RpcTransport
  private readonly onEvent: (record: Record<string, unknown>) => void
  private readonly onExit: (code: number | null) => void
  private readonly onUiRequest: (record: Record<string, unknown>) => void
  private readonly onExtensionStatus: (record: Record<string, unknown>) => void
  private readonly pending = new Map<string, PendingRequest>()
  private stderrBuffer = ''
  private nextId = 1
  private exited = false
  private disposed = false

  constructor(options: PiRpcOptions) {
    this.onEvent = options.onEvent ?? (() => undefined)
    // A dialog without a consumer must still be answered or pi stalls waiting
    // for a human; the driver always supplies its own handler that surfaces it.
    this.onUiRequest = options.onUiRequest ?? ((record) => this.dismissUiDialog(record))
    this.onExtensionStatus = options.onExtensionStatus ?? (() => undefined)
    this.onExit = options.onExit ?? (() => undefined)
    if (options.transport) {
      this.child = null
      this.transport = options.transport
    } else {
      const invocation = options.invocation
      if (invocation === undefined) {
        throw new Error('PiRpcClient needs an invocation to spawn or a transport to speak on')
      }
      const child = this.spawnChild(invocation)
      this.child = child
      this.transport = localRpcTransport(child)
    }
    this.transport.onLine((line) => this.consumeLine(line))
    // Capped rolling tail so a crash reason (missing dependency, bad flag,
    // uncaught exception) reaches the error surfaced to the user instead of
    // a bare "exited with code 1" that gives no clue what went wrong.
    this.transport.onStderr((text) => {
      this.stderrBuffer = `${this.stderrBuffer}${text}`.slice(-4_000)
    })
    this.transport.onError?.((error) => {
      this.failAll(new Error(`Failed to launch pi: ${error.message}`))
    })
    this.transport.onExit((code) => {
      this.exited = true
      const detail = this.stderrBuffer.trim()
      // The stderr tail (which usually contains the crash's stack trace) must
      // stay OUT of the error message: the error card renders `message` as the
      // beautified body and only the Raw Error view may show the full trace.
      // Carry the stderr tail in `cause` instead; the engine's raw-error
      // extraction walks the cause chain to surface it there.
      this.failAll(
        new Error(`Pi process exited with code ${code ?? 'unknown'}`, {
          ...(detail ? { cause: detail } : {})
        })
      )
      this.onExit(code)
    })
  }

  private spawnChild(invocation: PreparedHarnessInvocation): ChildProcess {
    // Bundled Pi (electron run-as-node) must run in-process inside Electron's
    // utilityProcess helper; a direct child registers a standalone LaunchServices
    // app on macOS and bounces a terminal-like Dock icon per session.
    return invocation.runtime?.target?.kind === 'bundled'
      ? spawnInUtilityHost(invocation)
      : spawn(invocation.command, invocation.args, {
          ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
          env: invocation.env,
          shell: invocation.shell,
          stdio: ['pipe', 'pipe', 'pipe']
        })
  }

  get running(): boolean {
    if (this.disposed) return false
    // A local child answers from its own handle, exactly as it always has; an
    // injected transport has only the exit it already reported.
    return this.child ? !this.child.killed : !this.exited
  }

  /** The spawned `pi --mode rpc` child, exposed so drivers can register it
   * with the app's process tracker (task manager, orphan reaping). */
  get process(): ChildProcess {
    if (!this.child) throw new Error('This Pi session has no local process')
    return this.child
  }

  /** Send an RPC command and resolve with its `data` once the matching response arrives. */
  send(command: Record<string, unknown>): Promise<unknown> {
    if (!this.available) {
      return Promise.reject(new Error('Pi process is not running'))
    }
    const id = String(this.nextId++)
    const payload = JSON.stringify({ ...command, id })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id)
          reject(new Error(`Pi command ${String(command['type'])} timed out`))
        },
        command['type'] === 'compact' ? COMPACTION_IDLE_TIMEOUT_MS : REQUEST_TIMEOUT_MS
      )
      this.pending.set(id, { resolve, reject, timer, compacting: command['type'] === 'compact' })
      void this.transport.write(payload).catch((error: unknown) => {
        const pending = this.pending.get(id)
        if (!pending) return
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      })
    })
  }

  /** Create a fresh Pi session bound to the current project. */
  async newSession(): Promise<void> {
    await this.send({ type: 'new_session' })
  }

  /**
   * Load a previously persisted Pi session file so the conversation continues
   * with its full native history. Rejects when pi rejects the switch or an
   * extension cancels it (`session_before_switch`), so the caller can fall
   * back to a fresh session.
   */
  async switchSession(sessionPath: string): Promise<void> {
    const data = await this.send({ type: 'switch_session', sessionPath })
    if (record(data)?.['cancelled'] === true) {
      throw new Error('Pi cancelled the session switch (session_before_switch)')
    }
  }

  /**
   * Send a prompt turn. The response resolves at preflight; events stream after.
   *
   * `streamingBehavior` answers the one race a caller cannot answer itself: pi
   * refuses a bare `prompt` outright while a run is streaming. Asking it for
   * `'steer'` lets pi queue the message into that run, or start the turn when
   * nothing is streaming, in the same step it reads its own state   so there is
   * no window in which a queued steer could land on a run that has already
   * stopped. Pi builds that predate the field ignore it and answer with their
   * streaming guard instead, which the caller has to recover from (see
   * `PiDriver.promptIntoSession`).
   */
  async prompt(
    message: string,
    images?: PiRpcImage[],
    streamingBehavior?: 'steer' | 'followUp'
  ): Promise<void> {
    await this.send({
      type: 'prompt',
      message,
      ...(images && images.length > 0 ? { images } : {}),
      ...(streamingBehavior ? { streamingBehavior } : {})
    })
  }

  /** Steer the active turn. Requires a running turn. */
  async steer(message: string, images?: PiRpcImage[]): Promise<void> {
    await this.send(
      images && images.length > 0 ? { type: 'steer', message, images } : { type: 'steer', message }
    )
  }

  /** Queue a follow-up message processed after the agent finishes. Unlike
   *  `steer`, this is accepted while no turn is streaming   pi runs it as the
   *  continuation of the session (after compaction/retry windows settle). */
  async followUp(message: string, images?: PiRpcImage[]): Promise<void> {
    await this.send(
      images && images.length > 0
        ? { type: 'follow_up', message, images }
        : { type: 'follow_up', message }
    )
  }

  async abort(): Promise<void> {
    await this.send({ type: 'abort' })
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.send({ type: 'set_model', provider, modelId })
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.send({ type: 'set_thinking_level', level })
  }

  /** Resolve the models available to the current Pi runtime. */
  async getAvailableModels(): Promise<unknown> {
    return this.send({ type: 'get_available_models' })
  }

  /** Resolve the current session model, thinking level, and streaming state. */
  async getState(): Promise<unknown> {
    return this.send({ type: 'get_state' })
  }

  /** Resolve token usage, cost, and context-window statistics for this session. */
  async getSessionStats(): Promise<unknown> {
    return this.send({ type: 'get_session_stats' })
  }

  /** Manually compact the conversation context to reduce token usage. */
  async compact(customInstructions?: string): Promise<unknown> {
    return this.send(
      customInstructions ? { type: 'compact', customInstructions } : { type: 'compact' }
    )
  }

  /** Enable or disable automatic compaction when context is nearly full. */
  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.send({ type: 'set_auto_compaction', enabled })
  }

  /** Enable or disable automatic retry on transient provider errors. */
  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.send({ type: 'set_auto_retry', enabled })
  }

  /** List slash commands / skills / prompt templates invokable via `/name`. */
  async getCommands(): Promise<unknown> {
    return this.send({ type: 'get_commands' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.failAll(new Error('Pi process disposed'))
    if (this.child) {
      if (!this.child.killed) this.child.kill()
      return
    }
    void this.transport.close().catch(() => undefined)
  }

  /** Whether a command can still be written to the peer. */
  private get available(): boolean {
    if (this.disposed) return false
    if (this.child) return this.child.stdin !== null && !this.child.killed
    return !this.exited
  }

  private consumeLine(line: string): void {
    if (!line.trim()) return
    let record: Record<string, unknown>
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value !== 'object' || value === null) return
      record = value as Record<string, unknown>
    } catch {
      return
    }
    const type = record['type']
    if (type === 'response') {
      this.resolveResponse(record)
      return
    }
    if (type === 'extension_ui_request') {
      if (
        record['method'] === 'setStatus' &&
        record['statusKey'] === PI_COMPACTION_EXTENSION_KEY &&
        record['statusText'] === 'progress'
      ) {
        for (const pending of this.pending.values()) {
          if (pending.compacting) pending.timer.refresh()
        }
      }
      // Only dialog methods block on a client response. Fire-and-forget methods
      // (notify, setStatus, setWidget, setTitle, set_editor_text) never expect a
      // reply, so answering them would be noise.
      if (isExtensionUiDialogMethod(record['method'])) {
        this.onUiRequest(record)
        return
      }
      if (isExtensionStatusMethod(record['method'])) this.onExtensionStatus(record)
      return
    }
    this.onEvent(record)
  }

  private resolveResponse(record: Record<string, unknown>): void {
    const id = typeof record['id'] === 'number' ? String(record['id']) : record['id']
    if (typeof id !== 'string') return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    if (record['success'] === true) {
      pending.resolve(record['data'])
    } else {
      pending.reject(
        new Error(typeof record['error'] === 'string' ? record['error'] : 'Pi command failed')
      )
    }
  }

  /** Resolve a dialog request using Pi's extension UI response protocol. */
  respondToExtensionUiRequest(
    requestId: string | number,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): void {
    void this.transport
      .write(JSON.stringify({ type: 'extension_ui_response', id: requestId, ...response }))
      .catch(() => undefined)
  }

  /** Auto-dismiss a dialog when no consumer is attached so the agent never stalls. */
  private dismissUiDialog(record: Record<string, unknown>): void {
    const id = record['id']
    if (typeof id !== 'string' && typeof id !== 'number') return
    this.respondToExtensionUiRequest(id, { cancelled: true })
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Dialog extension UI methods that block until the client replies. */
function isExtensionUiDialogMethod(method: unknown): boolean {
  return method === 'select' || method === 'confirm' || method === 'input' || method === 'editor'
}

/** Fire-and-forget extension UI methods that carry observable state. */
function isExtensionStatusMethod(method: unknown): boolean {
  return method === 'setStatus' || method === 'notify' || method === 'setWidget'
}
