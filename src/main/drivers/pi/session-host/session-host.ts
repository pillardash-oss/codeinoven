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
import { join, resolve } from 'node:path'
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager
} from '@earendil-works/pi-coding-agent'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type {
  HostCreateSessionCommand,
  HostEventEnvelope,
  HostNoticeEnvelope,
  HostRequestEnvelope,
  HostResponseEnvelope,
  HostSessionListEntry,
  HostSessionState
} from './protocol'

/** Lines the host pushes to its transport. */
export type HostLineSink = (
  line: HostResponseEnvelope | HostEventEnvelope | HostNoticeEnvelope
) => void

interface HostedSession {
  readonly key: string
  readonly session: AgentSession
  readonly unsubscribe: () => void
  readonly cwd: string
}

export class PiSessionHost {
  private readonly sessions = new Map<string, HostedSession>()

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
        // turn then streams through the event channel, exactly like RPC.
        let responded = false
        void hosted.session
          .prompt(command.message, {
            ...(command.images === undefined ? {} : { images: command.images }),
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
    const services = await createAgentSessionServices({
      cwd: command.cwd,
      agentDir: command.agentDir,
      ...(command.extensionPaths === undefined || command.extensionPaths.length === 0
        ? {}
        : { resourceLoaderOptions: { additionalExtensionPaths: [...command.extensionPaths] } })
    })
    const sessionManager = command.sessionPath
      ? SessionManager.open(command.sessionPath, undefined, command.cwd)
      : SessionManager.create(command.cwd, nativeSessionDir(command.agentDir, command.cwd))
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
      ...(command.tools === undefined ? {} : { tools: [...command.tools] })
    })
    const unsubscribe = created.session.subscribe((event) => {
      this.sink({ type: 'event', sessionId: key, event })
    })
    this.sessions.set(key, { key, session: created.session, unsubscribe, cwd: command.cwd })
    return this.stateOf(key)
  }

  private disposeSession(key: string): void {
    const hosted = this.sessions.get(key)
    if (hosted === undefined) return
    this.sessions.delete(key)
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
