import { spawn, type ChildProcess } from 'node:child_process'
import type { PreparedHarnessInvocation } from './harness-runtime'

/**
 * A single Pi image content block, sent with a prompt or steer message.
 */
export interface PiRpcImage {
  type: 'image'
  data: string
  mimeType: string
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface PiRpcOptions {
  /** Prepared native or WSL invocation, including `--mode rpc`. */
  invocation: PreparedHarnessInvocation
  /** Called once per agent event record streamed from the pi process. */
  onEvent?: (record: Record<string, unknown>) => void
  /** Called for dialog-style extension UI requests that need a human answer. */
  onUiRequest?: (record: Record<string, unknown>) => void
  /** Called once when the pi process exits unexpectedly. */
  onExit?: (code: number | null) => void
}

const REQUEST_TIMEOUT_MS = 120_000

/**
 * Minimal JSONL RPC client for `pi --mode rpc` (installed on the user's PATH).
 *
 * Pi's headless RPC mode accepts length-prefixed JSON commands on stdin and
 * emits JSON events plus `{ type: "response" }` records on stdout. This client
 * owns the spawned `pi` process, correlates responses by their `id`, forwards
 * agent events to a callback, and answers Pi's extension UI requests so the
 * agent never blocks on an unattended dialog.
 *
 * The driver keeps this in-process only to speak the protocol; the actual agent
 * runs in the `pi` binary the user installs, mirroring how Claude Code is used.
 */
export class PiRpcClient {
  private readonly child: ChildProcess
  private readonly onEvent: (record: Record<string, unknown>) => void
  private readonly onExit: (code: number | null) => void
  private readonly onUiRequest: (record: Record<string, unknown>) => void
  private readonly pending = new Map<string, PendingRequest>()
  private buffer = ''
  private nextId = 1
  private disposed = false

  constructor(options: PiRpcOptions) {
    this.onEvent = options.onEvent ?? (() => undefined)
    // A dialog without a consumer must still be answered or pi stalls waiting
    // for a human; the driver always supplies its own handler that surfaces it.
    this.onUiRequest = options.onUiRequest ?? ((record) => this.dismissUiDialog(record))
    this.onExit = options.onExit ?? (() => undefined)
    this.child = spawn(options.invocation.command, options.invocation.args, {
      ...(options.invocation.cwd ? { cwd: options.invocation.cwd } : {}),
      env: options.invocation.env,
      shell: options.invocation.shell,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stdout?.on('data', (chunk: Buffer) => this.consume(chunk.toString()))
    this.child.stderr?.on('data', () => undefined)
    this.child.on('error', (error) => {
      this.failAll(new Error(`Failed to launch pi: ${error.message}`))
      this.onExit(null)
    })
    this.child.on('exit', (code) => {
      this.failAll(new Error(`Pi process exited with code ${code ?? 'unknown'}`))
      this.onExit(code)
    })
  }

  get running(): boolean {
    return !this.disposed && !this.child.killed
  }

  /** Send an RPC command and resolve with its `data` once the matching response arrives. */
  send(command: Record<string, unknown>): Promise<unknown> {
    if (this.disposed || !this.child.stdin || this.child.killed) {
      return Promise.reject(new Error('Pi process is not running'))
    }
    const id = String(this.nextId++)
    const payload = JSON.stringify({ ...command, id })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Pi command ${String(command['type'])} timed out`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin?.write(`${payload}\n`)
    })
  }

  /** Create a fresh Pi session bound to the current project. */
  async newSession(): Promise<void> {
    await this.send({ type: 'new_session' })
  }

  /** Send a prompt turn. The response resolves at preflight; events stream after. */
  async prompt(message: string, images?: PiRpcImage[]): Promise<void> {
    await this.send(
      images && images.length > 0
        ? { type: 'prompt', message, images }
        : { type: 'prompt', message }
    )
  }

  /** Steer the active turn. Requires a running turn. */
  async steer(message: string, images?: PiRpcImage[]): Promise<void> {
    await this.send(
      images && images.length > 0 ? { type: 'steer', message, images } : { type: 'steer', message }
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
    if (!this.child.killed) this.child.kill()
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    const lines = this.buffer.split(/\r?\n/u)
    this.buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      this.consumeLine(line)
    }
  }

  private consumeLine(line: string): void {
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
      // Only dialog methods block on a client response. Fire-and-forget methods
      // (notify, setStatus, setWidget, setTitle, set_editor_text) never expect a
      // reply, so answering them would be noise.
      if (isExtensionUiDialogMethod(record['method'])) this.onUiRequest(record)
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
    this.child.stdin?.write(
      `${JSON.stringify({ type: 'extension_ui_response', id: requestId, ...response })}\n`
    )
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

/** Dialog extension UI methods that block until the client replies. */
function isExtensionUiDialogMethod(method: unknown): boolean {
  return method === 'select' || method === 'confirm' || method === 'input' || method === 'editor'
}
