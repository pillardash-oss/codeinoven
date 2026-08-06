/**
 * Main-process dispatcher for the phone client's remote RPC bridge.
 *
 * The phone PWA speaks the same `invoke`/`subscribe` surface as the desktop
 * renderer, but instead of Electron IPC the calls arrive over the encrypted
 * WebSocket bridge. This dispatcher resolves each channel to the SAME service
 * used by the desktop IPC handlers (ThreadManager, ProjectManager,
 * ChatEngine), so the phone sees an identical data surface — threads, messages,
 * settings, permissions — and can stream live `agent:event` updates.
 *
 * Security: only channels in `REMOTE_ALLOWED_CHANNELS` are ever dispatched;
 * anything else is rejected before touching a service.
 */

import type { Database } from '../database/database'
import { ThreadManager } from '../../lib/engines/thread-manager'
import { ProjectManager } from '../../lib/engines/project-manager'
import { ProjectFilesService } from '../project-files-service'
import type { ChatEngine } from '../chat-engine'
import { broadcastThreadUpdate } from '../thread-events'
import { REMOTE_ALLOWED_CHANNELS } from '../../lib/remote-rpc'
import type {
  CreateThreadInput,
  PromptAttachment,
  PromptAssignmentTaskReference,
  PromptProjectReference,
  PromptReference,
  SpecActionIntent,
  Thread,
  ThreadContextUsage,
  ThreadSettings,
  UserMessagePresentation
} from '../../lib/types'
import { Logger } from '../logger'

export interface RemoteRpcServices {
  database: Database
  chatEngine: Pick<
    ChatEngine,
    | 'loadMessages'
    | 'deleteThreadSession'
    | 'listProviderSnapshot'
    | 'getSessionStatus'
    | 'ensureSession'
    | 'sendPrompt'
    | 'steerPrompt'
    | 'abort'
    | 'listPermissions'
    | 'replyPermission'
    | 'listQuestions'
    | 'answerQuestion'
  >
  projectManager?: ProjectManager
}

/** A remote RPC invoke request that reached the main process. */
export interface RemoteInvoke {
  id: number
  channel: string
  args: unknown[]
}

export type RemoteRpcResult = { ok: true; result: unknown } | { ok: false; message: string }

export class RemoteRpcDispatcher {
  private readonly threadManager: ThreadManager
  private readonly projectManager: ProjectManager
  private readonly projectFilesService: ProjectFilesService

  constructor(private readonly services: RemoteRpcServices) {
    this.threadManager = new ThreadManager(services.database, broadcastThreadUpdate, (thread) => {
      void services.chatEngine.deleteThreadSession(thread.projectId, thread.id)
    })
    this.projectManager = services.projectManager ?? new ProjectManager(services.database)
    this.projectFilesService = new ProjectFilesService(this.projectManager)
  }

  /** Whether a channel is callable over the remote bridge. */
  isAllowed(channel: string): boolean {
    return REMOTE_ALLOWED_CHANNELS.includes(channel)
  }

  /** Dispatch a validated invoke. Returns the result or a rejected reason. */
  async dispatch(invoke: RemoteInvoke): Promise<RemoteRpcResult> {
    if (!this.isAllowed(invoke.channel)) {
      return { ok: false, message: `Channel not allowed over the remote bridge: ${invoke.channel}` }
    }
    try {
      const result = await this.call(invoke.channel, invoke.args)
      return { ok: true, result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      Logger.error(`Remote RPC ${invoke.channel} failed:`, error)
      return { ok: false, message }
    }
  }

  private async call(channel: string, args: unknown[]): Promise<unknown> {
    const { chatEngine } = this.services
    switch (channel) {
      case 'project:list':
        return this.projectManager.listProjects()
      case 'project:get':
        return this.projectManager.getProject(this.string(args[0]))
      case 'thread:listAll':
        return this.threadManager.listAllThreads()
      case 'thread:list':
        return this.threadManager.listThreads(this.string(args[0]))
      case 'thread:get':
        return this.threadManager.getThread(this.string(args[0]), this.string(args[1]))
      case 'thread:create':
        return this.threadManager.createThread(args[0] as CreateThreadInput)
      case 'thread:markRead':
        return this.threadManager.markRead(this.string(args[0]), this.string(args[1]))
      case 'thread:setArchived':
        return this.threadManager.setArchived(
          this.string(args[0]),
          this.string(args[1]),
          Boolean(args[2])
        )
      case 'thread:setPinned':
        return this.threadManager.setPinned(
          this.string(args[0]),
          this.string(args[1]),
          Boolean(args[2])
        )
      case 'thread:setStatus':
        return this.threadManager.setStatus(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]) as Thread['status'],
          args[3] as { read?: boolean } | undefined
        )
      case 'thread:updateSettings':
        return this.threadManager.updateSettings(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings
        )
      case 'thread:setContextUsage':
        this.threadManager.setContextUsage(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadContextUsage
        )
        return undefined
      case 'agent:loadMessages':
        return chatEngine.loadMessages(this.string(args[0]), this.string(args[1]))
      case 'agent:listProviderSnapshot':
        return chatEngine.listProviderSnapshot(this.string(args[0]))
      case 'agent:getSessionStatus':
        return chatEngine.getSessionStatus(this.string(args[0]), this.string(args[1]))
      case 'agent:ensureSession':
        return chatEngine.ensureSession(this.string(args[0]), this.string(args[1]))
      case 'agent:sendPrompt':
        return chatEngine.sendPrompt(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as ThreadSettings,
          this.string(args[3]),
          (args[4] ?? []) as PromptAttachment[],
          args[5] as SpecActionIntent | undefined,
          this.optionalString(args[6]),
          this.optionalString(args[7]),
          args[8] as PromptReference[] | undefined,
          args[9] as PromptProjectReference[] | undefined,
          (args[10] as 'user' | 'internal') ?? 'user',
          args[11] as UserMessagePresentation | undefined,
          args[12] as PromptAssignmentTaskReference[] | undefined
        )
      case 'agent:steerPrompt':
        return chatEngine.steerPrompt(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          (args[3] ?? []) as PromptAttachment[],
          this.string(args[4]),
          this.optionalString(args[5]),
          args[6] as PromptReference[] | undefined,
          args[7] as PromptProjectReference[] | undefined,
          args[8] as UserMessagePresentation | undefined,
          args[9] as PromptAssignmentTaskReference[] | undefined
        )
      case 'agent:abort':
        return chatEngine.abort(this.string(args[0]), this.string(args[1]))
      case 'agent:listPermissions':
        return chatEngine.listPermissions(this.string(args[0]), this.string(args[1]))
      case 'agent:replyPermission':
        return chatEngine.replyPermission(
          this.string(args[0]),
          this.string(args[1]),
          args[2] as 'once' | 'always' | 'reject',
          typeof args[3] === 'string' ? args[3] : undefined
        )
      case 'agent:listQuestions':
        return chatEngine.listQuestions(this.string(args[0]), this.string(args[1]))
      case 'agent:answerQuestion':
        return chatEngine.answerQuestion(
          this.string(args[0]),
          this.string(args[1]),
          this.string(args[2]),
          args[3] as string[][]
        )
      case 'projectFiles:resolveCitationPaths':
        return this.projectFilesService.resolveCitationPaths(
          this.string(args[0]),
          (args[1] ?? []) as string[]
        )
      case 'shell:openExternal':
        // Opening an external browser from a phone makes no sense; accept the
        // call so the shared renderer's link handling does not error.
        return undefined
      default:
        throw new Error(`Unknown remote channel: ${channel}`)
    }
  }

  private string(value: unknown): string {
    if (typeof value !== 'string') throw new TypeError('Expected a string argument')
    return value
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined
  }
}
