/**
 * A hosted session, driven through the same surface the driver already uses.
 *
 * The driver was written against `PiRpcClient`, which speaks Pi's JSON RPC mode
 * over a child process. This client answers the same calls from a session on the
 * long-lived host instead, and translates in both directions:
 *
 *  - commands map onto host commands (`prompt`, `steer`, `follow_up`, `abort`,
 *    `new_session`, `switch_session`, `compact`), and the four data calls the
 *    driver reads are answered by the host from the session's own services.
 *  - host events are passed through unwrapped, because that is the shape the
 *    driver's event handler switches on.
 *  - dialogs and status lines are re-wrapped as `extension_ui_request`, the record
 *    the driver already knows how to turn into a permission card.
 *
 * Nothing here decides anything: permissions, accounts and paths stay in the app.
 */
import type { PiHostSupervisor } from '../../agents/pi-host-supervisor'
import type { PiSessionClient } from './pi-client'
import type { PiRpcImage } from '../pi-rpc-client'
import { Logger } from '../../system/logger'
import type { HostSessionState, HostUiResponse } from '../pi/session-host/protocol'

export interface PiHostClientOptions {
  supervisor: PiHostSupervisor
  sessionId: string
  cwd: string
  /** The account's agent directory; omitted for an account that names none. */
  agentDir?: string
  /** Provider credentials the session's model runtime and extensions read. */
  sessionEnv?: Record<string, string>
  extensionPaths: string[]
  thinkingLevel?: string
  onEvent?: (record: Record<string, unknown>) => void
  onUiRequest?: (record: Record<string, unknown>) => void
  onExtensionStatus?: (record: Record<string, unknown>) => void
  onExit?: (code: number | null) => void
}

export class PiHostClient implements PiSessionClient {
  readonly #options: PiHostClientOptions
  #disposed = false
  #started = false
  #exitReported = false
  readonly #unsubscribeUi: () => void
  readonly #unsubscribeEvents: () => void
  readonly #unsubscribeLost: () => void
  readonly #unsubscribeNotice: () => void

  constructor(options: PiHostClientOptions) {
    this.#options = options
    this.#unsubscribeUi = options.supervisor.onUiRequest((sessionId, request) => {
      if (sessionId !== options.sessionId) return
      if (request.method === 'notify' || request.method === 'setStatus') {
        options.onExtensionStatus?.({
          type: 'extension_ui_request',
          method: request.method,
          ...(request.method === 'setStatus'
            ? { statusKey: request.statusKey, statusText: request.statusText }
            : { message: request.message, notifyType: request.notifyType })
        })
        return
      }
      options.onUiRequest?.({
        type: 'extension_ui_request',
        id: request.id,
        method: request.method,
        ...('title' in request ? { title: request.title } : {}),
        ...('message' in request ? { message: request.message } : {}),
        ...('placeholder' in request ? { placeholder: request.placeholder } : {}),
        ...('options' in request ? { options: request.options } : {}),
        ...('timeout' in request ? { timeout: request.timeout } : {})
      })
    })
    this.#unsubscribeEvents = options.supervisor.onEvent((sessionId, event) => {
      if (sessionId !== options.sessionId) return
      options.onEvent?.(event)
    })
    // A host that exits takes this session's process with it, but not its
    // transcript. The driver has to hear about it now, not on the next request:
    // otherwise the thread stays working and the worker cards never settle.
    this.#unsubscribeLost = options.supervisor.onSessionLost((sessionId) => {
      if (sessionId !== options.sessionId) return
      this.#reportExit(null)
    })
    // A host notice names something that happened inside the host and carries no
    // request id: an extension that failed to load, for instance. It is the only
    // trace of that failure, so it belongs in the app log rather than nowhere.
    this.#unsubscribeNotice = options.supervisor.onNotice((sessionId, notice) => {
      if (sessionId !== undefined && sessionId !== options.sessionId) return
      const message = `[pi host] ${notice.message}`
      if (notice.level === 'error') Logger.error(message)
      else Logger.dev(message)
    })
  }

  get running(): boolean {
    if (this.#disposed || !this.#started) return false
    return this.#options.supervisor.hostOf(this.#options.sessionId) !== null
  }

  /** The host process that runs this session, for the app's service list. */
  get pid(): number {
    return this.#options.supervisor.hostOf(this.#options.sessionId) ?? 0
  }

  /** Create the hosted session. Called once, before any command. */
  async start(): Promise<void> {
    if (this.#started) return
    await this.#options.supervisor.createSession({
      sessionId: this.#options.sessionId,
      command: {
        type: 'create_session',
        cwd: this.#options.cwd,
        ...(this.#options.agentDir === undefined ? {} : { agentDir: this.#options.agentDir }),
        ...(this.#options.sessionEnv === undefined ? {} : { sessionEnv: this.#options.sessionEnv }),
        dialogs: true,
        extensionPaths: this.#options.extensionPaths,
        ...(this.#options.thinkingLevel === undefined
          ? {}
          : {
              thinkingLevel: this.#options.thinkingLevel as NonNullable<
                Parameters<PiHostSupervisor['createSession']>[0]['command']['thinkingLevel']
              >
            })
      }
    })
    this.#started = true
  }

  async newSession(): Promise<void> {
    await this.start()
    await this.#sendState({ type: 'new_session' })
  }

  async switchSession(sessionPath: string): Promise<void> {
    await this.start()
    await this.#sendState({ type: 'switch_session', sessionPath })
  }

  async prompt(
    message: string,
    images?: PiRpcImage[],
    streamingBehavior?: 'steer' | 'followUp'
  ): Promise<void> {
    await this.start()
    if (streamingBehavior === 'steer') {
      await this.steer(message, images)
      return
    }
    if (streamingBehavior === 'followUp') {
      await this.followUp(message, images)
      return
    }
    await this.send({ type: 'prompt', message, ...(images === undefined ? {} : { images }) })
  }

  async steer(message: string, images?: PiRpcImage[]): Promise<void> {
    await this.start()
    await this.send({ type: 'steer', message, ...(images === undefined ? {} : { images }) })
  }

  async followUp(message: string, images?: PiRpcImage[]): Promise<void> {
    await this.start()
    await this.send({ type: 'follow_up', message, ...(images === undefined ? {} : { images }) })
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    await this.start()
    await this.send({ type: 'set_model', provider, modelId })
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.start()
    await this.send({ type: 'set_thinking_level', level })
  }

  async abort(): Promise<void> {
    await this.send({ type: 'abort' })
  }

  async compact(customInstructions?: string): Promise<unknown> {
    await this.start()
    return this.send({
      type: 'compact',
      ...(customInstructions === undefined ? {} : { instructions: customInstructions })
    })
  }

  async getState(): Promise<unknown> {
    const state = await this.#sendState({ type: 'get_state' })
    return {
      sessionId: state.nativeSessionId,
      sessionFile: state.sessionFile,
      cwd: state.cwd,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      isStreaming: state.isStreaming,
      isCompacting: state.isCompacting,
      messageCount: state.messageCount,
      pendingMessageCount: state.pendingMessageCount
    }
  }

  async getSessionStats(): Promise<unknown> {
    await this.start()
    return this.send({ type: 'get_session_stats' })
  }

  async getAvailableModels(): Promise<unknown> {
    await this.start()
    return this.send({ type: 'get_available_models' })
  }

  async getCommands(): Promise<unknown> {
    await this.start()
    return this.send({ type: 'get_commands' })
  }

  /** Pi's own compaction policy, per session, exactly as the RPC client sets it. */
  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.start()
    await this.send({ type: 'set_auto_compaction', enabled })
  }

  /** Pi's own retry policy, so a stopped turn is not resurrected by a retry. */
  async setAutoRetry(enabled: boolean): Promise<void> {
    await this.start()
    await this.send({ type: 'set_auto_retry', enabled })
  }

  /** Answer a dialog the host forwarded, in the RPC response shape. */
  respondToExtensionUiRequest(
    requestId: string | number,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean }
  ): void {
    const answer: HostUiResponse =
      response.cancelled === true
        ? { cancelled: true }
        : response.confirmed !== undefined
          ? { confirmed: response.confirmed }
          : { value: response.value ?? '' }
    void this.#options.supervisor.respondToUi(this.#options.sessionId, String(requestId), answer)
  }

  /** Answer a dialog through the host (same thing, spelled for this client). */
  async send(command: Record<string, unknown>): Promise<unknown> {
    await this.start()
    const applied = await this.#options.supervisor.request(
      this.#options.sessionId,
      command as Parameters<PiHostSupervisor['request']>[1]
    )
    if (!applied.ok) throw new Error(applied.error)
    return applied.data
  }

  /**
   * Move this session to a host of its own and answer where it landed.
   *
   * The transcript travels, so the native session id does not change; only the
   * process does.
   */
  async moveToNewHost(): Promise<{ hostPid: number; nativeSessionId: string }> {
    const state = await this.#options.supervisor.moveToNewHost(this.#options.sessionId)
    return {
      hostPid: this.#options.supervisor.hostOf(this.#options.sessionId) ?? 0,
      nativeSessionId: state.nativeSessionId
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribeUi()
    this.#unsubscribeEvents()
    this.#unsubscribeLost()
    this.#unsubscribeNotice()
    void this.#options.supervisor.disposeSession(this.#options.sessionId).catch(() => undefined)
  }

  /** Report the host's death once, even if a caller also notices it is gone. */
  #reportExit(code: number | null): void {
    if (this.#exitReported || this.#disposed) return
    this.#exitReported = true
    this.#options.onExit?.(code)
  }

  async #sendState(command: Parameters<PiHostSupervisor['request']>[1]): Promise<HostSessionState> {
    const applied = await this.#options.supervisor.request(this.#options.sessionId, command)
    if (!applied.ok) throw new Error(applied.error)
    return applied.data as HostSessionState
  }
}
