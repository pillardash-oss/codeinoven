import { join, posix, resolve } from 'path'
import { existsSync } from 'fs'
import { ChatEngine } from '../chat-engine'
import { Logger } from '../../system/logger'
import { PERMISSION_EVENTS_LOG_FILE, dailyLogRelativePath } from '../../system/log-paths'
import { PermissionPolicy, normalizePermissionName } from '../../permissions/permission-policy'
import {
  tempWorkspaceReferences,
  tempWorkspaceRefusal,
  type TempWorkspaceReference
} from '../../../lib/temp-workspace'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import { PermissionRequestGoneError } from '../../drivers/driver.interface'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { AgentEvent, PermissionReply, PermissionRequest, Thread } from '../../../lib/types'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '../../../lib/types'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import {
  PROJECT_DATA_DIRECTORY,
  chatThreadWorkspaceDirectory
} from '../../../lib/project-artifacts'
import { messageId as createMessageId } from '../../../lib/id'
import {
  unmanagedBrowserShellReason,
  unmanagedProcessKillReason
} from '../../../lib/agent-control-policy'
import type { PendingPermissionInfo, SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { permissionCommands } from './chat-engine-generated-artifacts'
import { chatSkillPaths } from './chat-engine-pure'
import { agentCreationTargets } from '../../permissions/agent-created-files'
import { posixDirname } from '../../../lib/paths'
import type { AgentPart } from '../../../lib/types'
import { isOvenMode, isUnrestrictedLevel } from '../../../lib/permission-level'
import { isRemoteOvenId } from '../../../lib/ovens'

/**
 * The permission kinds that mean "an operation on a file". Every other kind is
 * the chat's own work: its web access and the tools it was given.
 */ const FILE_SYSTEM_PERMISSIONS = new Set([
  'read',
  'write',
  'edit',
  'delete',
  'move',
  'bash',
  'execute',
  'file',
  'files',
  'bundled-pi-sensitive-files'
])

/** Permission names that only read: a read is not agent work in the temp
 *  directory, so an attached file that lives there still opens. */
const TEMP_READ_TERMS = new Set(['read', 'grep', 'glob', 'find', 'list', 'ls', 'search', 'view'])

/** Permission names that change something, whatever else they also say. */
const TEMP_WRITE_TERMS = new Set(['write', 'edit', 'delete', 'move', 'create', 'exec', 'execute'])
/**
 * The app-owned gateway tool a request would run, if that is what it is.
 *
 * The app serves the turn's gateway MCP server itself, and every route behind it
 * enforces its own permission, so a card for one of those calls asks the user to
 * authorize the app to call the app.
 */
function appGatewayToolCall(metadata: Record<string, unknown>): string | undefined {
  const input = metadata['input']
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const provider = record['providerIdentifier']
  const tool = record['toolName']
  if (typeof tool !== 'string' || !tool.startsWith('cio_')) return undefined
  // `utilities` is the transport name the app gives its own gateway server. An
  // agent that omits the provider still names the call in the app's namespace,
  // which no user MCP server shares.
  if (provider !== undefined && provider !== 'utilities') return undefined
  return tool
}

/**
 * The OS temp references a request would work in, if any.
 *
 * The app's own gateway tools are exempt: their routes carry their own checks,
 * and the app itself may legitimately open a temp file. Reads are exempt too, so
 * an attached file that lives in temp still opens; everything else that names a
 * temp path is refused before any policy runs.
 */
export function tempWorkspaceRequestReferences(
  request: PermissionRequest,
  commands: readonly string[]
): TempWorkspaceReference[] {
  if (appGatewayToolCall(request.metadata) !== undefined) return []
  if (commands.length > 0) return tempWorkspaceReferences(commands)
  if (isTempReadPermission(request.permission)) return []
  return tempWorkspaceReferences(request.patterns)
}

function isTempReadPermission(permission: string): boolean {
  const terms = normalizePermissionName(permission)
    .split(/[^a-z]+/u)
    .filter(Boolean)
  if (terms.some((term) => TEMP_WRITE_TERMS.has(term))) return false
  return terms.some((term) => TEMP_READ_TERMS.has(term))
}

/** The scratch folder an agent stages disposable work in, spelled the way the
 *  session's own machine spells it: an Oven is POSIX even from a Windows
 *  desktop, and its own paths must never be re-serialized by this host. */
function scratchFolderHint(projectPath: string): string {
  return projectPath.startsWith('/')
    ? posix.join(projectPath, PROJECT_DATA_DIRECTORY, 'tmp')
    : join(projectPath, PROJECT_DATA_DIRECTORY, 'tmp')
}

/** ChatEngine permissions: one concern, moved verbatim from the composition root. */
export class ChatEnginePermissions {
  constructor(private readonly host: ChatEngine) {}

  /** Reply to a pending permission request (from the UI permission card). */
  async replyPermission(
    projectId: string,
    requestId: string,
    reply: PermissionReply,
    alternative?: string
  ): Promise<void> {
    this.host.units['messages'].touchUserActivity()
    projectId = validateEntityId(projectId, 'Project ID')
    requestId = validateEntityId(requestId, 'Permission request ID', 256)
    if (reply !== 'once' && reply !== 'always' && reply !== 'reject') {
      throw new TypeError('Invalid permission reply')
    }
    const alternativeInstruction =
      alternative === undefined
        ? undefined
        : validateBoundedString(alternative, 'Alternative instruction', 1, 20_000)
    if (alternativeInstruction !== undefined && reply !== 'reject') {
      throw new TypeError('An alternative instruction must reject the requested action')
    }
    if (
      await this.host.state.ovenChat.permission(projectId, requestId, reply, alternativeInstruction)
    )
      return
    const pending = this.host.state.pendingPermissions.get(requestId)
    if (!pending || pending.session.projectId !== projectId) {
      Logger.dev(`Ignoring reply for resolved permission request: ${requestId}`)
      return
    }
    await this.settlePermissionReply(pending, reply, 'user', alternativeInstruction)
  }

  /**
   * The one path from a decided permission card to the harness.
   *
   * A user's answer and the card's own deadline both settle here, because both
   * are the same decision: what changes is who made it (`decidedBy`) and whether
   * a corrective instruction rides along with the rejection.
   */
  private async settlePermissionReply(
    pending: PendingPermissionInfo,
    reply: PermissionReply,
    decidedBy: string,
    alternativeInstruction?: string
  ): Promise<void> {
    if (this.host.state.pendingPermissions.get(pending.request.id) !== pending) return
    this.clearPermissionTimer(pending)

    const driver =
      pending.driver ??
      this.host.units['turns-dispatch'].driverForRuntime(
        pending.driverId,
        pending.session.accountId
      )
    if (!driver) throw new Error(`Harness driver is unavailable: ${pending.driverId}`)
    if (
      pending.policy.approval.expiresAt !== undefined &&
      pending.policy.approval.expiresAt <= Date.now()
    ) {
      await driver.replyPermission(
        pending.session.projectPath,
        pending.request.id,
        'reject',
        undefined,
        pending.request.sessionId
      )
      await this.recordPermissionDecision(pending, 'reject', 'policy:expired')
      this.dropPendingPermission(pending)
      throw new Error(`Permission request expired: ${pending.request.id}`)
    }
    if (reply === 'always' && pending.policy.risk === 'critical') {
      throw new Error('Critical permissions cannot be approved permanently')
    }

    // An alternative rejects the blocked action but delivers the user's
    // instruction to the harness as corrective feedback (`message`), so the
    // model continues the SAME turn seeing what to do instead. The harness
    // fails the blocked tool call with that feedback and keeps streaming   no
    // abort and no re-prompt, both of which used to interrupt the harness's
    // continuation of the current turn.
    const resolvedReply = alternativeInstruction !== undefined ? 'reject' : reply
    try {
      await driver.replyPermission(
        pending.session.projectPath,
        pending.request.id,
        resolvedReply,
        alternativeInstruction,
        pending.request.sessionId
      )
    } catch (error) {
      if (!(error instanceof PermissionRequestGoneError)) throw error
      this.dropPendingPermission(pending)
      await this.recordPermissionDecision(pending, resolvedReply, `${decidedBy}:stale-request`)
      // The decision cannot be delivered after the driver's blocking request
      // disappears. Never pretend the turn resumed: terminate it cleanly so a
      // stale approval or rejection cannot leave a tool call spinning forever.
      await this.interruptRejectedPermission(pending, driver)
      Logger.dev(`Reconciled resolved permission request: ${pending.request.id}`)
      return
    }
    await this.recordPermissionDecision(pending, resolvedReply, decidedBy)
    this.dropPendingPermission(pending)
    if (reply === 'reject' && alternativeInstruction === undefined) {
      await this.interruptRejectedPermission(pending, driver)
      return
    }
    const sideChat = this.host.units['temporary-chats'].temporaryChatForSession(
      pending.session.sessionId
    )
    // A side chat blocks only its own turn: resuming a permission never rewrites
    // the parent thread's status, which stayed untouched when the request came up.
    if (!sideChat) {
      await this.host.threadManager.setStatus(
        pending.session.projectId,
        pending.session.threadId,
        pending.resumeStatus
      )
    }
    if (alternativeInstruction !== undefined) {
      const alternativeMessageId = createMessageId()
      if (sideChat) {
        // The side chat owns its transcript: the alternative is shown there and
        // never written into the parent thread's conversation.
        this.host.units['temporary-chats'].recordTemporaryDisplayMessage(
          sideChat.id,
          sideChat.sessionId,
          alternativeMessageId,
          alternativeInstruction,
          [],
          [],
          alternativeInstruction
        )
        this.host.units['temporary-chats'].refreshTemporaryChatExpiry(sideChat)
        return
      }
      // Surface the alternative as a visible user message; the harness already
      // received it as corrective feedback on the permission reply. An automatic
      // deadline refuses for the user here, so the record says the app decided
      // instead of pretending they typed the instruction.
      const settledByUser = decidedBy === 'user'
      const alternativeText = [
        `The requested ${pending.request.permission} action was rejected.`,
        `Do not perform the requested ${pending.request.permission} action.`,
        'Continue seamlessly by following the user-provided alternative below.',
        'User alternative:',
        alternativeInstruction
      ].join('\n\n')
      await this.host.units['messages-write'].persistOutboundMessage(
        pending.session.projectId,
        pending.session.threadId,
        alternativeMessageId,
        alternativeInstruction,
        settledByUser
          ? alternativeText
          : [
              `The requested ${pending.request.permission} action was automatically rejected:`,
              'nobody answered the permission card before its deadline.',
              'Find another way to finish the task without that action.',
              'Automatic instruction:',
              alternativeInstruction
            ].join('\n\n'),
        [],
        [],
        [],
        {
          action: `Alternative for ${pending.request.permission}`,
          body: alternativeInstruction
        },
        'user'
      )
    }
  }

  /**
   * Arm (or re-arm) the deadline of a card waiting for the user.
   *
   * The countdown holds while the user is active anywhere in the app, exactly as
   * the question and secret cards do: a card must never expire under someone who
   * is still working, and an abandoned one gets a full window of its own rather
   * than a deadline measured from when it appeared.
   */
  async schedulePermissionTimeout(pending: PendingPermissionInfo): Promise<void> {
    const requestId = pending.request.id
    if (this.host.state.pendingPermissions.get(requestId) !== pending) return
    this.clearPermissionTimer(pending)
    const timeoutMs = await this.cardTimeoutMs()
    if (this.host.state.pendingPermissions.get(requestId) !== pending) return

    if (this.host.units['turns'].isUserActive()) {
      pending.expiresAt = undefined
      pending.timer = setTimeout(
        () => void this.schedulePermissionTimeout(pending),
        ChatEngine.INACTIVITY_CHECK_INTERVAL_MS
      )
      pending.timer.unref?.()
      this.reflectDeadline(pending)
      return
    }

    if (pending.expiresAt === undefined) pending.expiresAt = Date.now() + timeoutMs
    const delay = Math.max(0, pending.expiresAt - Date.now())
    this.reflectDeadline(pending)
    pending.timer = setTimeout(() => {
      pending.timer = undefined
      if (this.host.state.pendingPermissions.get(requestId) !== pending) return
      // The user came back while this window ran: hold the card instead of
      // refusing a request under their hands.
      if (this.host.units['turns'].isUserActive()) {
        pending.expiresAt = undefined
        void this.schedulePermissionTimeout(pending)
        return
      }
      void this.expirePermission(pending, timeoutMs).catch((error: unknown) =>
        Logger.error('Could not expire a permission card:', error)
      )
    }, delay)
    pending.timer.unref?.()
  }

  /**
   * Refuse a card at its deadline and let the run continue.
   *
   * Nothing can approve a permission on the user's behalf, so the card is
   * rejected. The instruction riding on the rejection is what keeps the turn
   * alive: the harness fails the one blocked call with that feedback and the
   * model continues the same turn looking for another way.
   */
  async expirePermission(pending: PendingPermissionInfo, timeoutMs: number): Promise<void> {
    if (this.host.state.pendingPermissions.get(pending.request.id) !== pending) return
    pending.expiresAt = undefined
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    const permission = pending.request.permission
    const instruction = [
      `The permission card for ${permission} was automatically rejected after ${minutes} minute(s) without an answer.`,
      'Do not retry that exact action.',
      'Find another way to finish the task without it, and if nothing works, say plainly what is blocked and why.'
    ].join(' ')
    this.host.units['misc'].reportAutoAnswer({
      id: pending.request.id,
      kind: 'permission',
      outcome: 'expired',
      projectId: pending.session.projectId,
      threadId: pending.session.threadId,
      entries: [
        {
          prompt: permission,
          header: 'Permission',
          options: ['Allow once', 'Allow always', 'Reject'],
          picked: 'Reject'
        }
      ],
      at: Date.now()
    })
    await this.settlePermissionReply(pending, 'reject', 'policy:timeout', instruction)
  }

  /** Publish the deadline on the card so the UI can show the same countdown. */
  private reflectDeadline(pending: PendingPermissionInfo): void {
    const policy = pending.request.policy
    if (!policy) return
    pending.request.policy = { ...policy, expiresAt: pending.expiresAt }
  }

  /** The configured human-card timeout, shared with questions and secret cards. */
  private async cardTimeoutMs(): Promise<number> {
    try {
      const config = await this.host.storage.getConfig()
      if (Number.isFinite(config.questionTimeoutMs) && config.questionTimeoutMs > 0)
        return config.questionTimeoutMs
    } catch (error) {
      Logger.error('Could not read the card timeout:', error)
    }
    return 5 * 60_000
  }

  private clearPermissionTimer(pending: PendingPermissionInfo): void {
    if (pending.timer) clearTimeout(pending.timer)
    pending.timer = undefined
  }

  /** Retire a settled card: its deadline dies with it. */
  private dropPendingPermission(pending: PendingPermissionInfo): void {
    this.clearPermissionTimer(pending)
    pending.expiresAt = undefined
    if (this.host.state.pendingPermissions.get(pending.request.id) === pending)
      this.host.state.pendingPermissions.delete(pending.request.id)
  }

  /** Stop a turn after the user plainly rejects its blocked action. */
  async interruptRejectedPermission(
    pending: PendingPermissionInfo,
    driver: HarnessDriver
  ): Promise<void> {
    const { sessionId } = pending.request
    // The decision is final the moment the user makes it, so everything that
    // answers the user to it settles before the harness is asked to stop: the
    // rejected card closes, every other card this session owned closes, and the
    // thread stops reading as working. Only then is the abort awaited, because a
    // harness that is slow to stop (or wedged on a dialog) must never keep the
    // card on screen or the thread stuck on `working` while it decides.
    //
    // The abort emits `session.idle`, finalizing the interrupted checkpoint.
    // This must also run when the driver's dialog disappeared before the
    // renderer reply arrived, otherwise the blocked tool turn remains active.
    this.host.state.userAbortedSessions.add(sessionId)
    this.host.broadcast({
      type: 'permission.replied',
      sessionId,
      requestId: pending.request.id,
      reply: 'reject'
    })
    this.host.units['questions'].clearPendingQuestionsForSession(sessionId)
    this.clearPendingPermissionsForSession(sessionId)
    // A rejected side chat request interrupts only the side chat's turn; the
    // parent thread keeps whatever status it owned before the request.
    if (!this.host.units['temporary-chats'].temporaryChatForSession(sessionId)) {
      await this.host.threadManager.setStatus(
        pending.session.projectId,
        pending.session.threadId,
        'interrupted',
        { read: true }
      )
    }
    // A rejection ends the work the gate was blocking, and the image descriptor
    // runs its vision call in a disposable session of its own: without this it
    // would keep streaming, and even retry on another model, after the turn the
    // user just rejected is already gone.
    await this.host.units['media-visual'].abortImageDescriptorWork(
      sessionId,
      pending.session.threadId
    )
    await driver.abort(pending.session.projectPath, sessionId)
  }

  /**
   * List unresolved permission requests for renderer reconnect recovery.
   *
   * `preloadedThread` is the row an aggregate read already has: a caller that
   * just read the thread (the open digest) passes it so this never asks the
   * database worker for the same row again. `undefined` means "read it here",
   * and `null` means "already known to be absent", so every other call site
   * keeps answering exactly as before.
   */
  async listPermissions(
    projectId: string,
    threadId: string,
    preloadedThread?: Thread | null
  ): Promise<PermissionRequest[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const ovenThread =
      preloadedThread === undefined
        ? await this.host.threadManager.getThread(projectId, threadId)
        : preloadedThread
    if (ovenThread && this.host.state.ovenChat.remote(ovenThread))
      return this.host.state.ovenChat.permissions(ovenThread)

    return [...this.host.state.pendingPermissions.values()]
      .filter((pending) => {
        if (pending.session.projectId !== projectId) return false
        // A side chat's request belongs to the side chat's own conversation
        // never to the parent thread it was opened from. The parent thread's
        // composer, queued messages, and status must stay untouched by it.
        const sideChat = this.host.units['temporary-chats'].temporaryChatForSession(
          pending.session.sessionId
        )
        return sideChat ? sideChat.id === threadId : pending.session.threadId === threadId
      })
      .map((pending) => pending.request)
  }

  // ─── Permission policy ────────────────────────────────────────────────────

  /**
   * The file-access scope for a permission request in a chat session.
   *
   * A conversation that owns an app-storage workspace (a standalone chat's
   * `chats-cwd/<threadId>`, a browser tab's `browser-cwd/<threadId>`) gets that
   * workspace as a pre-authorized scratch path: non-destructive, path-scoped
   * file operations inside it never prompt, regardless of permission level or
   * File System mode.
   *
   * All threads retain an allowlist of user-supplied attachments and local
   * paths, including inputs outside the project. Inbox threads additionally
   * get the shared and active-harness skill roots. When File
   * System mode is off, safe read/list/search operations are restricted to
   * those paths. Skill access never grants writes or shell commands.
   * File-System-on chats keep the normal project-root + protected-path rules
   * while retaining these read-only exceptions.
   *
   * Temporary side chats get the same read-only skill roots as chats even
   * though they keep their project read scope: skills are harness runtime, not
   * user file access, and a read-only side chat must be able to load the skill
   * instructions its turn matches.
   */
  async chatPermissionScope(info: SessionInfo): Promise<{
    allowedPaths: string[]
    scratchPaths: string[]
    workspaceRoots: string[]
    restrictToAllowed: boolean
  }> {
    const isChat =
      info.projectId === INBOX_PROJECT_ID || info.projectId === GLOBAL_BROWSER_PROJECT_ID
    // A chat and a browser tab's agent chat each own an app-storage workspace,
    // and the directory their session runs in is that workspace, so it is
    // pre-authorized scratch. An assistant task deliberately gets none: it is
    // assistant-scoped, so its workspace is the assistant's own
    // `assistant-cwd/<assistantId>/` root and must never fall back to a chat
    // workspace directory for pre-authorized writes.
    const isAssistant = info.projectId === ASSISTANT_SPACE_ID
    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    // A chat on an external Oven works in that Oven's own thread root, not in
    // this machine's `chats-cwd/<threadId>`: the root the Oven hands the
    // session is the directory its shell starts in, and it is exactly as
    // disposable as a local chat workspace. Naming the local chat directory
    // here instead left every command unprovable on the Oven, so a plain
    // `ls -la` asked for approval of its own working directory. A project
    // thread on an Oven keeps its ordinary scope: that root is the project's
    // checkout, not a scratch folder.
    const ovenHosted = thread !== null && this.host.state.ovenChat.remote(thread)
    const ovenChatHosted = isChat && ovenHosted
    /** Keep an Oven's spelling for its own path; resolve only this machine's. */
    const remoteSessionPath = (path: string): string => (ovenHosted ? path : resolve(path))
    const scratchPaths = isAssistant
      ? []
      : ovenChatHosted
        ? [
            // An Oven's paths are spelled by that machine, so this host's
            // resolver must never touch them: on a Windows desktop
            // `resolve('/home/u/x')` became `D:\\home\\u\\x`, a path that exists
            // on neither machine and that no request from the Oven could match.
            remoteSessionPath(info.projectPath)
          ]
        : info.projectId === GLOBAL_BROWSER_PROJECT_ID
          ? [info.projectPath]
          : [this.host.storage.resolve(chatThreadWorkspaceDirectory(info.threadId))]
    // An assistant, a standalone chat, and a browser tab's agent chat each own
    // the directory their session runs in (`assistant-cwd/<assistantId>`,
    // `chats-cwd/<threadId>`, `browser-cwd/<threadId>`), so the sensitive-file
    // block list never asks about a file inside it: that name is the session's
    // own work, not a secret it is reaching for. The card still covers
    // everything that leaves the workspace, and a project thread keeps the list
    // everywhere because its cwd holds the project's real secrets. A project
    // thread that runs in its own scope worktree is the same case as a chat
    // workspace: the `.env` it writes there next to `.env.example` is its own
    // work, so that directory is exempt while the project root stays gated.
    const workspaceRoots = isAssistant ? [remoteSessionPath(info.projectPath)] : []
    // A thread in a real project also owns that project's `.cio` scratch folder:
    // it is where the agent stages its own work, so deletes and confined shell
    // commands there never prompt. `.cio/specs` and `.cio/git` stay gated inside
    // the policy, because the platform owns those.
    if (!isChat && !isAssistant) {
      scratchPaths.push(
        ovenHosted
          ? posix.join(info.projectPath, PROJECT_DATA_DIRECTORY)
          : resolve(info.projectPath, PROJECT_DATA_DIRECTORY)
      )
      const workingDirectory = thread?.workingDirectory
      if (
        workingDirectory &&
        remoteSessionPath(workingDirectory) !== remoteSessionPath(info.projectPath)
      ) {
        workspaceRoots.push(remoteSessionPath(workingDirectory))
      }
    }
    // Reuse the allowlist until a user message invalidates it; permission
    // requests must not rescan the conversation for every file operation.
    const cached = this.host.state.chatAttachmentAllowlists.get(info.threadId)
    const attachmentPaths =
      cached ?? (await this.host.units['runtime-workflows'].collectChatAttachmentPaths(info))
    if (cached === undefined)
      this.host.state.chatAttachmentAllowlists.set(info.threadId, attachmentPaths)
    if (!isChat) {
      const skillPaths = this.host.units['temporary-chats'].temporaryChatForSession(info.sessionId)
        ? chatSkillPaths(info.driverId)
        : []
      return {
        allowedPaths: [...attachmentPaths, ...skillPaths],
        scratchPaths,
        workspaceRoots,
        restrictToAllowed: false
      }
    }

    const fileSystemMode = thread?.settings?.fileSystemMode === true
    return {
      allowedPaths: [...attachmentPaths, ...chatSkillPaths(info.driverId)],
      scratchPaths,
      // A chat owns its workspace only once it may write there: with File
      // System off it is restricted to the attached files, so the workspace
      // earns no exemption from the sensitive-file list either.
      workspaceRoots: fileSystemMode ? [remoteSessionPath(info.projectPath)] : [],
      restrictToAllowed: !fileSystemMode
    }
  }

  /** Release only this check's waiting cards after the user disables it. */
  async refreshSensitiveFilePermissions(): Promise<void> {
    if ((await this.host.storage.getConfig()).bundledPiSensitiveFileProtectionEnabled !== false)
      return
    const pending = [...this.host.state.pendingPermissions.values()].filter(
      (entry) => entry.request.permission === 'bundled-pi-sensitive-files'
    )
    for (let index = 0; index < pending.length; index++) {
      if (index > 0 && index % 8 === 0) await new Promise<void>((done) => setImmediate(done))
      const entry = pending[index]
      if (!entry || this.host.state.pendingPermissions.get(entry.request.id) !== entry) continue
      const createdPaths = [
        ...(this.host.state.agentCreatedFiles.get(entry.session.sessionId) ?? [])
      ]
      entry.policy = new PermissionPolicy({
        projectRoot: entry.session.projectPath,
        mode: entry.session.permissionLevel ?? 'auto_review',
        sensitiveFileProtectionEnabled: false,
        ...(createdPaths.length > 0 ? { agentCreatedPaths: createdPaths } : {})
      }).evaluate({ permission: entry.request.permission, paths: entry.request.patterns })
      try {
        await this.replyPermissionRaw(entry, 'once', 'settings:sensitive-files-disabled')
      } catch (error) {
        if (!(error instanceof PermissionRequestGoneError)) {
          Logger.error('Could not release a disabled sensitive-file check:', error)
          continue
        }
        this.host.state.pendingPermissions.delete(entry.request.id)
        this.clearPermissionTimer(entry)
      }
      if (this.host.state.pendingPermissions.has(entry.request.id)) continue
      this.host.broadcast({
        type: 'permission.replied',
        sessionId: entry.request.sessionId,
        requestId: entry.request.id,
        reply: 'once'
      })
      const remaining = [...this.host.state.pendingPermissions.values()].some(
        (other) => other.request.sessionId === entry.request.sessionId
      )
      if (
        !remaining &&
        !this.host.units['temporary-chats'].temporaryChatForSession(entry.request.sessionId)
      ) {
        await this.host.threadManager
          .setStatus(entry.session.projectId, entry.session.threadId, entry.resumeStatus)
          .catch((error: unknown) => Logger.error('Could not resume a released file check:', error))
      }
    }
  }

  /**
   * Remember the files a session creates, from the tool parts every harness
   * already streams. Auto Review uses the result to let an agent remove its own
   * throwaway work without a card, so the ledger has to be exact: a target is
   * only kept when it did not exist yet while the call was running, which is
   * what separates a creation from an overwrite of the user's own file.
   *
   * A harness that never publishes the call's input before it runs simply adds
   * nothing here, and the ordinary card keeps asking.
   */
  trackToolCreations(
    sessionId: string,
    part: Extract<AgentPart, { type: 'tool' }>,
    projectPath: string
  ): void {
    const key = `${sessionId}:${part.callID}`
    const status = part.state.status
    if (status === 'pending' || status === 'running') {
      // Snapshots arrive more than once. The first readable one decides.
      if (this.host.state.pendingToolCreations.has(key)) return
      const targets = agentCreationTargets(part.tool, part.state.input, projectPath)
      if (targets.length === 0) return
      const missing: string[] = []
      for (const target of targets) {
        if (existsSync(target)) continue
        missing.push(target)
        // A created directory brings its missing parents with it`mkdir -p
        // a/b/c` creates all three), so removing the tree the agent made stays
        // the agent's own cleanup.
        let parent = posixDirname(target)
        for (let depth = 0; depth < 16 && parent && !existsSync(parent); depth += 1) {
          missing.push(parent)
          const next = posixDirname(parent)
          if (next === parent) break
          parent = next
        }
      }
      if (missing.length === 0) return
      this.host.state.pendingToolCreations.set(key, [...new Set(missing)])
      return
    }
    const created = this.host.state.pendingToolCreations.get(key)
    this.host.state.pendingToolCreations.delete(key)
    if (status !== 'completed' || created === undefined || created.length === 0) return
    const existing = this.host.state.agentCreatedFiles.get(sessionId)
    const paths = existing ?? new Set<string>()
    for (const path of created) paths.add(path)
    if (existing === undefined) this.host.state.agentCreatedFiles.set(sessionId, paths)
  }

  /** Drop the in-flight creation bookkeeping of a session that is going away. */
  dropSessionCreations(sessionId: string): void {
    this.host.state.agentCreatedFiles.delete(sessionId)
    const prefix = `${sessionId}:`
    for (const key of this.host.state.pendingToolCreations.keys()) {
      if (key.startsWith(prefix)) this.host.state.pendingToolCreations.delete(key)
    }
  }

  /** Resolve a permission request per the thread's permission level. */
  async handlePermissionAsked(
    driverId: string,
    event: Extract<AgentEvent, { type: 'permission.asked' }>,
    sourceDriver?: HarnessDriver
  ): Promise<void> {
    const { sessionId, permission: request } = event
    const info = this.host.sessionRegistry.get(sessionId)
    const level = info?.permissionLevel ?? 'auto_review'
    if (!info) {
      Logger.error('Permission request has no registered session:', request.id)
      return
    }

    const commands = permissionCommands(request.metadata)
    // The OS temp directory is an invariant, not a permission tier: the session
    // has its own scratch folder, and a temp path is where half-finished work
    // leaks out of a turn. Every harness that asks the app before it writes or
    // runs a shell command passes through here (the bundled Pi included), so
    // this is the one place the ban is enforced for all of them: refused with
    // the scratch folder named, never a card, and never approvable by a
    // permission mode. Reads are exempt so a file the user attached from temp
    // still opens.
    const tempReferences = tempWorkspaceRequestReferences(request, commands)
    if (tempReferences.length > 0) {
      const reason = tempWorkspaceRefusal(tempReferences, scratchFolderHint(info.projectPath))
      const scope = { projectRoot: info.projectPath, paths: request.patterns }
      const pending: PendingPermissionInfo = {
        driverId,
        driver: sourceDriver,
        session: info,
        request: {
          ...request,
          policy: { risk: 'critical', reason, scopedPaths: [...request.patterns] }
        },
        policy: {
          decision: 'ask',
          approved: false,
          reason,
          risk: 'critical',
          scope,
          approval: { required: true },
          ledger: {
            permission: normalizePermissionName(request.permission),
            risk: 'critical',
            decision: 'ask',
            reason,
            scope
          }
        },
        resumeStatus: info.activeTurnId ? 'executing' : 'planning'
      }
      this.host.state.pendingPermissions.set(request.id, pending)
      // A refusal that carries its reason: the harness fails this one call with
      // the text and the same turn continues in the session's scratch folder,
      // instead of aborting or parking on a card.
      await this.replyPermissionRaw(pending, 'reject', 'policy:temp-workspace', reason)
      return
    }
    // Process lifecycle is an invariant, not a permission tier. A command that
    // stops a process by pid, port, name, pattern, signal, interpreter or script
    // can only reach something this session did not start, so it is answered
    // here with a refusal instead of a card: this is the one place every harness
    // that asks the app before running a shell command passes through, which is
    // how ACP agents and Claude Code reach us. A card would be auto-approved in
    // Full Access and would let the same command run.
    const unclassifiedTool = request.metadata['surface']
    const sensitiveFileProtectionEnabled =
      request.permission !== 'bundled-pi-sensitive-files' ||
      (await this.host.storage.getConfig()).bundledPiSensitiveFileProtectionEnabled !== false
    const { allowedPaths, scratchPaths, workspaceRoots, restrictToAllowed } =
      await this.chatPermissionScope(info)
    const agentCreatedPaths = [...(this.host.state.agentCreatedFiles.get(info.sessionId) ?? [])]
    let policy = new PermissionPolicy({
      projectRoot: info.projectPath,
      // Oven Mode is the one level that outranks the file-access restriction:
      // the whole point of it is that the machine is someone else's and the task
      // needs everything on it, so the chat clamp must not demote it.
      mode: !isOvenMode(level) && restrictToAllowed ? 'auto_review' : level,
      sensitiveFileProtectionEnabled,
      ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
      ...(scratchPaths.length > 0 ? { scratchPaths } : {}),
      ...(agentCreatedPaths.length > 0 ? { agentCreatedPaths } : {}),
      ...(workspaceRoots.length > 0 ? { workspaceRoots } : {}),
      ...(restrictToAllowed ? { restrictToAllowed } : {})
    }).evaluate({
      permission: request.permission,
      paths: request.patterns.filter((pattern) => !commands.includes(pattern)),
      commands,
      ...(typeof unclassifiedTool === 'string' && unclassifiedTool.trim().length > 0
        ? { unclassifiedTool: unclassifiedTool.trim() }
        : {})
    })
    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    // A chat is told to go to the web: its own system prompt makes search and
    // fetch the first answer for anything it does not know, so a card for an
    // outbound request contradicts the contract the same session just received
    // and parks a run the user asked for. Only file access is the chat's gate;
    // a project thread keeps the full policy, where an outbound request is a
    // real decision about the project.
    const chatScope =
      info.projectId === INBOX_PROJECT_ID || info.projectId === GLOBAL_BROWSER_PROJECT_ID
    // Two calls never need a card:
    //  - a tool the app itself serves. The gateway the turn received is the app's
    //    own MCP server, and its routes already carry their own permission
    //    checks, so asking the user to approve `cio_util_find` asks them to
    //    authorize CodeInOven to talk to CodeInOven.
    //  - anything a chat does that is not file access. A chat's contract is that
    //    the web is its first answer for what it does not know, and only file
    //    access is the gate; a network or tool card there contradicts the prompt
    //    the same session was given and parks a run the user asked for.
    const appOwnedTool = appGatewayToolCall(request.metadata)
    // What makes a request file access is what it acts on, not the word the
    // harness used for it: a web search arrives labelled `read` from some agents,
    // and a file read always carries the path it will open (a shell command
    // always carries the command line).
    const touchesFiles = request.patterns.length > 0 || commands.length > 0
    const chatNonFile =
      chatScope &&
      !touchesFiles &&
      request.permission !== 'bundled-pi-sensitive-files' &&
      !FILE_SYSTEM_PERMISSIONS.has(request.permission)
    if ((appOwnedTool !== undefined || chatNonFile) && !policy.approved) {
      const reason =
        appOwnedTool !== undefined
          ? `Auto-approved: ${appOwnedTool} is an app-owned tool.`
          : 'Auto-approved: a chat reaches the web and its tools directly; only file access asks.'
      policy = {
        ...policy,
        approved: true,
        decision: 'auto_review',
        reason,
        approval: { ...policy.approval, required: false, expiresAt: undefined },
        ledger: {
          ...policy.ledger,
          decision: 'auto_review',
          reason,
          expiresAt: undefined
        }
      }
    }
    const sensitiveFileApproval = request.permission === 'bundled-pi-sensitive-files'
    if (!policy.approved) {
      policy = {
        ...policy,
        approval: {
          ...policy.approval,
          expiresAt: undefined
        },
        ledger: {
          ...policy.ledger,
          expiresAt: undefined
        }
      }
    }
    const enrichedRequest: PermissionRequest = {
      ...request,
      policy: {
        risk: policy.risk,
        reason: policy.reason,
        expiresAt: policy.approval.expiresAt,
        scopedPaths: [...policy.scope.paths]
      }
    }
    const resumeStatus: PendingPermissionInfo['resumeStatus'] = info.activeTurnId
      ? 'executing'
      : 'planning'
    const pending: PendingPermissionInfo = {
      driverId,
      driver: sourceDriver,
      session: info,
      request: enrichedRequest,
      policy,
      resumeStatus
    }
    this.host.state.pendingPermissions.set(request.id, pending)
    this.host.units['turns'].markHarnessActive(info.projectId, info.driverId)

    // The refusal is answered before any tier logic below can approve it.
    const threadBrowserAvailable = !isRemoteOvenId(thread?.settings?.ovenId)
    const refusedCommand = commands.find(
      (command) =>
        unmanagedProcessKillReason('bash', { command }) !== null ||
        unmanagedBrowserShellReason(
          'bash',
          { command },
          {
            threadBrowserAvailable,
            cwd: info.projectPath
          }
        ) !== null
    )
    if (refusedCommand !== undefined) {
      const processReason = unmanagedProcessKillReason('bash', { command: refusedCommand })
      const browserReason = unmanagedBrowserShellReason(
        'bash',
        { command: refusedCommand },
        { threadBrowserAvailable, cwd: info.projectPath }
      )
      await this.replyPermissionRaw(
        pending,
        'reject',
        processReason ? 'policy:process-lifecycle' : 'policy:browser-ownership',
        processReason ?? browserReason ?? undefined
      )
      return
    }

    // A temporary side chat registers its session against the parent thread, but
    // its permission gate is the side chat's own: the parent thread is idle and
    // must keep its status, unread flag, and headline untouched by a blocking
    // request the user answers inside the side chat's window.
    const sideChat = this.host.units['temporary-chats'].temporaryChatForSession(info.sessionId)
    // When an automatic resolution fails (e.g. the gated harness turn had not
    // settled so the continuation could not start), surface the request as
    // needing attention instead of stranding the thread silently.
    const surfaceForApproval = async (): Promise<void> => {
      if (!sideChat) {
        await this.host.threadManager.setStatus(
          info.projectId,
          info.threadId,
          'awaiting_approval',
          {
            read: false
          }
        )
      }
      if (this.host.state.pendingPermissions.get(request.id) !== pending) return
      this.host.broadcast({ ...event, permission: enrichedRequest })
      // A card nobody answers must not park the turn forever. The deadline is
      // armed only once the card is actually on screen, and the same timeout the
      // question and secret cards use applies here.
      await this.schedulePermissionTimeout(pending)
    }
    if (
      info.projectId === GLOBAL_BROWSER_PROJECT_ID &&
      restrictToAllowed &&
      !policy.approved &&
      (commands.length > 0 ||
        /(?:read|edit|write|glob|grep|list|bash|shell|external.directory)/iu.test(
          request.permission
        ))
    ) {
      await this.replyPermissionRaw(pending, 'reject', 'policy:filesystem-disabled')
      return
    }
    if (
      !sensitiveFileApproval &&
      (await this.host.units['runtime-workflows'].achievementOwnsDecisions(thread ?? null))
    ) {
      try {
        await this.replyPermissionRaw(
          pending,
          isUnrestrictedLevel(level) ? 'always' : 'once',
          `achievement:${level}`
        )
        return
      } catch (error) {
        Logger.error('Permission auto-approval failed; surfacing for attention', {
          requestId: request.id,
          reason: rawErrorMessage(error)
        })
        await surfaceForApproval()
        return
      }
    }

    if (policy.approved) {
      try {
        await this.replyPermissionRaw(pending, 'once', `policy:${level}`)
        return
      } catch (error) {
        Logger.error('Permission auto-approval failed; surfacing for attention', {
          requestId: request.id,
          reason: rawErrorMessage(error)
        })
        await surfaceForApproval()
        return
      }
    }
    await surfaceForApproval()
  }

  async replyPermissionRaw(
    pending: PendingPermissionInfo,
    reply: PermissionReply,
    decidedBy: string,
    alternative?: string
  ): Promise<void> {
    if (pending.request.permission === 'bundled-pi-sensitive-files') {
      if (reply !== 'reject' && decidedBy !== 'user' && !pending.policy.approved) {
        throw new Error('Protected file access requires a user decision')
      }
      if (reply === 'always') throw new Error('Protected file access can only be approved once')
    }
    const driver =
      pending.driver ??
      this.host.units['turns-dispatch'].driverForRuntime(
        pending.driverId,
        pending.session.accountId
      )
    if (!driver) return
    await driver.replyPermission(
      pending.session.projectPath,
      pending.request.id,
      reply,
      // A policy refusal is a decision with words: without them the harness
      // fails the call with nothing, and the model retries the same thing.
      alternative,
      pending.request.sessionId
    )
    await this.recordPermissionDecision(pending, reply, decidedBy)
    this.dropPendingPermission(pending)
  }

  clearPendingPermissionsForSession(sessionId: string): void {
    for (const [requestId, pending] of this.host.state.pendingPermissions) {
      if (pending.request.sessionId === sessionId) {
        this.clearPermissionTimer(pending)
        this.host.state.pendingPermissions.delete(requestId)
        this.host.broadcast({ type: 'permission.replied', sessionId, requestId, reply: 'reject' })
      }
    }
  }

  async recordPermissionDecision(
    pending: PendingPermissionInfo,
    reply: PermissionReply,
    decidedBy: string
  ): Promise<void> {
    try {
      await this.host.storage.appendRaw(
        dailyLogRelativePath(PERMISSION_EVENTS_LOG_FILE),
        `${JSON.stringify({
          requestId: pending.request.id,
          sessionId: pending.request.sessionId,
          projectId: pending.session.projectId,
          threadId: pending.session.threadId,
          turnId: pending.session.activeTurnId,
          driverId: pending.driverId,
          permission: pending.request.permission,
          patterns: pending.request.patterns,
          risk: pending.policy.risk,
          reason: pending.policy.reason,
          scope: pending.policy.scope,
          expiresAt: pending.policy.approval.expiresAt,
          reply,
          decidedBy,
          timestamp: Date.now()
        })}\n`
      )
    } catch (error) {
      Logger.error('Permission audit write failed:', error)
    }
  }
}
