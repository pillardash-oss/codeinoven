/**
 * Pi session host: one process that owns many AgentSessions.
 *
 * The evidence behind this design (measured memory, isolation, streaming) is in
 * `.cio/work/pi-daemon-study/deep-dive-30-threads.md`. The short version:
 *
 *  - One cwd-bound services set per session. A shared loader retargets the
 *    extension runtime's action methods to the last bound session, so sessions
 *    must never share services.
 *  - Sessions carry their own cwd, so one host serves threads from any project
 *    of the same account. The account boundary (`agentDir`, auth, provider
 *    keys) is the process boundary.
 *  - Every event forwarded here carries the app's session key, and the client
 *    side of the protocol lives in `protocol.ts`.
 *
 * This module is not imported by the Electron main bundle yet; see the plan at
 * `.cio/work/pi-session-host/plan.md` (phase 1).
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  SessionManager
} from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { createHostUiContext } from './ui-context'
import { OWNED_SESSION_MARKER } from '../../../system/process-ownership'
import type { AgentSessionServices } from '@earendil-works/pi-coding-agent'
import type {
  HostCreateSessionCommand,
  HostEventEnvelope,
  HostNoticeEnvelope,
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionListEntry,
  HostSessionState,
  HostUiRequest,
  HostUiRequestEnvelope,
  HostUiResponse
} from './protocol'

/** Lines the host pushes to its transport. */
export type HostLineSink = (
  line: HostResponseEnvelope | HostEventEnvelope | HostNoticeEnvelope | HostUiRequestEnvelope
) => void

/** Pi's own default agent directory, used when an account does not name one. */
const DEFAULT_AGENT_DIR = join(homedir(), '.pi', 'agent')

/**
 * Widen a built-in shell tool to the SDK's custom-tool slot.
 *
 * `customTools` is typed with `unknown` details while a built-in shell tool
 * carries its own details type in both directions, so the SDK rejects the very
 * definition it built even though the runtime shape is identical. The cast only
 * erases that details parameter; no behaviour changes.
 */
function asCustomTool<T extends { name: string }>(definition: T): ToolDefinition {
  return definition as unknown as ToolDefinition
}

/**
 * The shell tools a hosted session runs with.
 *
 * The host is one process for every session, so the stamp in its own environment
 * names whichever session wrote it last, and a thread's commands would inherit
 * that one id and be attributed to another thread. Stamping each spawn from the
 * session that owns the turn is what lets the process tracker put a command
 * under its thread instead of under the app node, even while eight sessions
 * share this process.
 *
 * Only `bash` is replaced: the Windows-only `powershell` and `cmd` tools are
 * registered by the app's own extension with native operations, and overriding
 * them here would discard that implementation.
 */
function sessionShellTools(cwd: string, sessionId: string): ToolDefinition[] {
  const spawnHook: NonNullable<Parameters<typeof createBashToolDefinition>[1]>['spawnHook'] = (
    context
  ) => ({
    ...context,
    env: { ...context.env, [OWNED_SESSION_MARKER]: sessionId }
  })
  return [asCustomTool(createBashToolDefinition(cwd, { spawnHook }))]
}

interface HostedSession {
  readonly key: string
  readonly session: AgentSession
  readonly unsubscribe: () => void
  readonly cwd: string
  /** Account dir the session was created under, reported so it can be moved. */
  readonly agentDir: string
  /** Services the session was built from, so a new transcript can reuse them. */
  readonly services: AgentSessionServices
  /** Whether this session forwarded extension dialogs to the app. */
  readonly dialogs: boolean
  /** Model and thinking the session was created with, restored after a switch. */
  readonly modelId: { provider: string; id: string } | null
  readonly thinkingLevel: string
}

export class PiSessionHost {
  private readonly sessions = new Map<string, HostedSession>()

  /** Dialogs a session is blocked on, by request id, until the app answers. */
  private readonly pendingUi = new Map<
    string,
    { sessionId: string; resolve: (response: HostUiResponse) => void }
  >()

  constructor(private readonly sink: HostLineSink) {}

  /** Handle one request. Failures become an error response, never a crash. */
  async handle(request: HostRequestEnvelope): Promise<void> {
    const respond = (data?: unknown): void => {
      this.sink({
        type: 'response',
        id: request.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ok: true,
        ...(data === undefined ? {} : { data })
      })
    }
    const fail = (error: unknown): void => {
      this.sink({
        type: 'response',
        id: request.id,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ok: false,
        error: errorMessage(error)
      })
    }
    try {
      await this.dispatch(request, respond, fail)
    } catch (error) {
      fail(error)
    }
  }

  /** Dispose every hosted session (host shutdown). */
  dispose(): void {
    for (const key of [...this.sessions.keys()]) this.disposeSession(key)
  }

  private async dispatch(
    request: HostRequestEnvelope,
    respond: (data?: unknown) => void,
    fail: (error: unknown) => void
  ): Promise<void> {
    const command = request.command
    switch (command.type) {
      case 'create_session': {
        respond(await this.createSession(request.sessionId, command))
        return
      }
      case 'prompt': {
        const hosted = this.requireSession(request.sessionId)
        // Pi's RPC mode answers after prompt preflight, not at turn end; the
        // turn then streams through the event channel, exactly like RPC. The
        // steering preference travels as the RPC option, never as the `steer`
        // command: Pi ignores it on an idle session (the prompt starts a run)
        // and queues it only when a run is live.
        let responded = false
        void hosted.session
          .prompt(command.message, {
            ...(command.images === undefined ? {} : { images: command.images }),
            ...(command.streamingBehavior === undefined
              ? {}
              : { streamingBehavior: command.streamingBehavior }),
            source: 'rpc',
            preflightResult: (disposition) => {
              if (responded) return
              responded = true
              respond({ disposition })
            }
          })
          .catch((error: unknown) => {
            if (responded) {
              this.notice(hosted.key, 'error', errorMessage(error))
              return
            }
            responded = true
            fail(error)
          })
        return
      }
      case 'steer': {
        const hosted = this.requireSession(request.sessionId)
        const disposition = await hosted.session.steer(command.message, command.images, {
          source: 'rpc'
        })
        respond({ disposition })
        return
      }
      case 'follow_up': {
        const hosted = this.requireSession(request.sessionId)
        const disposition = await hosted.session.followUp(command.message, undefined, {
          source: 'rpc'
        })
        respond({ disposition })
        return
      }
      case 'get_session_stats': {
        const hosted = this.requireSession(request.sessionId)
        // The full stats walk, not only the context usage: the app reads the
        // cumulative cost and the token totals from the same payload, and the
        // RPC protocol this replaces returns exactly this shape.
        respond(hosted.session.getSessionStats())
        return
      }
      case 'get_available_models': {
        const hosted = this.requireSession(request.sessionId)
        respond({ models: hosted.services.modelRuntime.getModels() })
        return
      }
      case 'set_model': {
        const hosted = this.requireSession(request.sessionId)
        const model = hosted.services.modelRuntime.getModel(command.provider, command.modelId)
        if (model === undefined) {
          throw new Error(`Unknown model: ${command.provider}/${command.modelId}`)
        }
        await hosted.session.setModel(model)
        respond(this.stateOf(hosted.key))
        return
      }
      case 'set_thinking_level': {
        const hosted = this.requireSession(request.sessionId)
        hosted.session.setThinkingLevel(command.level)
        respond(this.stateOf(hosted.key))
        return
      }
      case 'set_auto_compaction': {
        const hosted = this.requireSession(request.sessionId)
        hosted.session.setAutoCompactionEnabled(command.enabled)
        respond({ enabled: hosted.session.autoCompactionEnabled })
        return
      }
      case 'set_auto_retry': {
        const hosted = this.requireSession(request.sessionId)
        hosted.session.setAutoRetryEnabled(command.enabled)
        respond({ enabled: hosted.session.autoRetryEnabled })
        return
      }
      case 'get_commands': {
        respond({ commands: [] })
        return
      }
      case 'new_session': {
        const hosted = this.requireSession(request.sessionId)
        const manager = SessionManager.create(
          hosted.cwd,
          nativeSessionDir(hosted.agentDir, hosted.cwd)
        )
        await this.replaceSession(hosted.key, manager)
        respond(this.stateOf(hosted.key))
        return
      }
      case 'switch_session': {
        const hosted = this.requireSession(request.sessionId)
        const manager = SessionManager.open(command.sessionPath, undefined, hosted.cwd)
        await this.replaceSession(hosted.key, manager)
        respond(this.stateOf(hosted.key))
        return
      }
      case 'compact': {
        const hosted = this.requireSession(request.sessionId)
        const result = await hosted.session.compact(command.instructions)
        respond(result)
        return
      }
      case 'abort': {
        await this.requireSession(request.sessionId).session.abort()
        respond()
        return
      }
      case 'dispose_session': {
        this.disposeSession(this.requireSessionKey(request.sessionId))
        respond()
        return
      }
      case 'get_state': {
        respond(this.stateOf(request.sessionId))
        return
      }
      case 'get_messages': {
        respond(this.requireSession(request.sessionId).session.messages)
        return
      }
      case 'ui_response': {
        const pending = this.pendingUi.get(command.requestId)
        // A dialog belongs to the session that asked it. An answer aimed at
        // another session is refused instead of resolving someone else's card.
        if (pending !== undefined && pending.sessionId !== request.sessionId) {
          respond({ resolved: false })
          return
        }
        this.pendingUi.delete(command.requestId)
        pending?.resolve(command.response)
        respond({ resolved: pending !== undefined })
        return
      }
      case 'list_sessions': {
        respond(this.listSessions())
        return
      }
    }
  }

  private async createSession(
    sessionId: string | undefined,
    command: HostCreateSessionCommand
  ): Promise<HostSessionState> {
    const key = this.requireSessionKey(sessionId)
    if (this.sessions.has(key)) throw new Error(`Session already exists: ${key}`)
    // An account that has not been configured yet names no agent directory. The
    // CLI falls back to Pi's own default there, so the host does the same rather
    // than refusing a session that account can already run.
    const agentDir = command.agentDir ?? DEFAULT_AGENT_DIR
    // Provider keys ride the session rather than a child environment. They are
    // applied to the host process before services are built, because that is
    // the moment the model runtime and the providers extension read them.
    if (command.sessionEnv !== undefined) {
      for (const [name, value] of Object.entries(command.sessionEnv)) process.env[name] = value
    }
    const services = await createAgentSessionServices({
      cwd: command.cwd,
      agentDir,
      ...(command.extensionPaths === undefined || command.extensionPaths.length === 0
        ? {}
        : { resourceLoaderOptions: { additionalExtensionPaths: [...command.extensionPaths] } })
    })
    // An extension that failed to load is never silent: the app-owned ones carry
    // the checkpoint policy and the tool surface, so a hosted session without
    // them looks alive and is not. The app sees the reason and stops the turn.
    for (const failure of services.resourceLoader.getExtensions().errors) {
      this.notice(key, 'error', `Extension failed to load: ${failure.path}: ${failure.error}`)
    }
    const sessionManager = command.sessionPath
      ? SessionManager.open(command.sessionPath, undefined, command.cwd)
      : SessionManager.create(command.cwd, nativeSessionDir(agentDir, command.cwd))
    const model =
      command.model === undefined
        ? undefined
        : services.modelRuntime.getModel(command.model.provider, command.model.id)
    if (command.model !== undefined && model === undefined) {
      throw new Error(`Unknown model: ${command.model.provider}/${command.model.id}`)
    }
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(model === undefined ? {} : { model }),
      ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }),
      ...(command.tools === undefined ? {} : { tools: [...command.tools] }),
      customTools: sessionShellTools(command.cwd, key)
    })
    const unsubscribe = created.session.subscribe((event) => {
      this.sink({ type: 'event', sessionId: key, event })
    })
    // A session's extensions ask their questions here, and every answer goes to
    // the app: the host renders nothing and decides nothing. Binding is opt-in
    // because the SDK builds the extension context with an interactive theme,
    // which a session that never asks a question does not need.
    if (command.dialogs === true) {
      await created.session.bindExtensions({
        uiContext: createHostUiContext(
          {
            ask: (request) => this.askUi(key, request),
            notify: (request) => this.sink({ type: 'ui_request', sessionId: key, request }),
            status: (request) => this.sink({ type: 'ui_request', sessionId: key, request })
          },
          { idPrefix: key }
        ),
        mode: 'rpc'
      })
    }
    this.sessions.set(key, {
      key,
      session: created.session,
      unsubscribe,
      cwd: command.cwd,
      agentDir,
      services,
      dialogs: command.dialogs === true,
      modelId: model === undefined ? null : { provider: model.provider, id: model.id },
      thinkingLevel: created.session.thinkingLevel
    })
    return this.stateOf(key)
  }

  /**
   * Swap the transcript a hosted session continues from.
   *
   * Pi has no session switch on an AgentSession, so the session is rebuilt from
   * the same services over the new transcript, with its model, thinking level and
   * dialog binding restored. The app's session key never changes: that is what
   * makes a resume, a fork or a fresh start invisible above this line.
   */
  private async replaceSession(key: string, manager: SessionManager): Promise<void> {
    const hosted = this.sessions.get(key)
    if (hosted === undefined) throw new Error(`Unknown session: ${key}`)
    const created = await createAgentSessionFromServices({
      services: hosted.services,
      sessionManager: manager,
      ...(hosted.modelId === null
        ? {}
        : {
            model: hosted.services.modelRuntime.getModel(hosted.modelId.provider, hosted.modelId.id)
          }),
      thinkingLevel: hosted.thinkingLevel as never
    })
    hosted.unsubscribe()
    hosted.session.dispose()
    this.sessions.delete(key)

    const unsubscribe = created.session.subscribe((event) => {
      this.sink({ type: 'event', sessionId: key, event })
    })
    if (hosted.dialogs) {
      await created.session.bindExtensions({
        uiContext: createHostUiContext(
          {
            ask: (request) => this.askUi(key, request),
            notify: (request) => this.sink({ type: 'ui_request', sessionId: key, request }),
            status: (request) => this.sink({ type: 'ui_request', sessionId: key, request })
          },
          { idPrefix: key }
        ),
        mode: 'rpc'
      })
    }
    this.sessions.set(key, {
      key,
      session: created.session,
      unsubscribe,
      cwd: hosted.cwd,
      agentDir: hosted.agentDir,
      services: hosted.services,
      dialogs: hosted.dialogs,
      modelId: hosted.modelId,
      thinkingLevel: created.session.thinkingLevel
    })
  }

  /** Forward one dialog to the app and resolve when the answer comes back. */
  private askUi(sessionId: string, request: HostUiRequest): Promise<HostUiResponse> {
    const key = this.requireSessionKey(sessionId)
    return new Promise<HostUiResponse>((resolve) => {
      this.pendingUi.set(request.id, { sessionId: key, resolve })
      if (request.method === 'notify') {
        this.pendingUi.delete(request.id)
        this.sink({ type: 'ui_request', sessionId: key, request })
        resolve({ cancelled: true })
        return
      }
      this.sink({ type: 'ui_request', sessionId: key, request })
    })
  }

  private disposeSession(key: string): void {
    const hosted = this.sessions.get(key)
    if (hosted === undefined) return
    this.sessions.delete(key)
    // A dialog nobody can answer any more is a cancelled dialog, never a hang.
    for (const [requestId, pending] of this.pendingUi) {
      if (pending.sessionId !== key) continue
      pending.resolve({ cancelled: true })
      this.pendingUi.delete(requestId)
    }
    hosted.unsubscribe()
    hosted.session.dispose()
  }

  private listSessions(): HostSessionListEntry[] {
    return [...this.sessions.values()].map((hosted) => ({
      sessionId: hosted.key,
      nativeSessionId: hosted.session.sessionId,
      cwd: hosted.cwd
    }))
  }

  private stateOf(sessionId: string | undefined): HostSessionState {
    const hosted = this.requireSession(sessionId)
    const model = hosted.session.model
    return {
      sessionId: hosted.key,
      nativeSessionId: hosted.session.sessionId,
      ...(hosted.session.sessionFile === undefined
        ? {}
        : { sessionFile: hosted.session.sessionFile }),
      cwd: hosted.cwd,
      agentDir: hosted.agentDir,
      ...(model === undefined ? {} : { model: { provider: model.provider, id: model.id } }),
      thinkingLevel: hosted.session.thinkingLevel,
      isStreaming: hosted.session.isStreaming,
      isCompacting: hosted.session.isCompacting,
      messageCount: hosted.session.messages.length,
      pendingMessageCount: hosted.session.pendingMessageCount
    }
  }

  private notice(sessionId: string | undefined, level: 'info' | 'error', message: string): void {
    this.sink({
      type: 'host_notice',
      ...(sessionId === undefined ? {} : { sessionId }),
      level,
      message
    })
  }

  private requireSessionKey(sessionId: string | undefined): string {
    if (sessionId === undefined) {
      throw new Error('This command requires a sessionId')
    }
    return sessionId
  }

  private requireSession(sessionId: string | undefined): HostedSession {
    const key = this.requireSessionKey(sessionId)
    const hosted = this.sessions.get(key)
    if (hosted === undefined) {
      throw new Error(`Unknown session: ${key}`)
    }
    return hosted
  }
}

/**
 * Mirror Pi's own session-dir encoding so resumed and newly created sessions
 * land in the same `<agentDir>/sessions/--<cwd>--` layout Pi itself uses.
 */
function nativeSessionDir(agentDir: string, cwd: string): string {
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
  const directory = join(agentDir, 'sessions', safePath)
  mkdirSync(directory, { recursive: true })
  return directory
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
