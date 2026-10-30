import { resolve } from 'path'
import { Logger } from '../../system/logger'
import { PERMISSION_EVENTS_LOG_FILE, dailyLogRelativePath } from '../../system/log-paths'
import { PermissionPolicy } from '../../permissions/permission-policy'
import { validateBoundedString, validateEntityId } from '../../ipc/ipc-validation'
import { PermissionRequestGoneError } from '../../drivers/driver.interface'
import type { HarnessDriver } from '../../drivers/driver.interface'
import type { AgentEvent, PermissionReply, PermissionRequest } from '../../../lib/types'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID, isAssistantThread } from '../../../lib/types'
import type { BrowserActionReview } from '../../browser/browser-service/browser-action-policy'
import { GLOBAL_BROWSER_PROJECT_ID } from '../../../lib/ipc/browser'
import {
  PROJECT_DATA_DIRECTORY,
  chatThreadWorkspaceDirectory
} from '../../../lib/project-artifacts'
import { messageId as createMessageId } from '../../../lib/id'
import type { PendingPermissionInfo, SessionInfo } from './chat-engine-types'
import { rawErrorMessage } from './chat-engine-errors'
import { permissionCommands } from './chat-engine-generated-artifacts'
import { chatSkillPaths } from './chat-engine-pure'
import type { ChatEngine } from '../chat-engine'

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

    if (pending.settleBrowserAction) {
      if (reply === 'always' && pending.policy.risk === 'critical') {
        throw new Error('Critical permissions cannot be approved permanently')
      }
      await this.replyPermissionRaw(pending, reply, 'user', alternativeInstruction)
      return
    }

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
        requestId,
        'reject',
        undefined,
        pending.request.sessionId
      )
      await this.recordPermissionDecision(pending, 'reject', 'policy:expired')
      this.host.state.pendingPermissions.delete(requestId)
      throw new Error(`Permission request expired: ${requestId}`)
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
        requestId,
        resolvedReply,
        alternativeInstruction,
        pending.request.sessionId
      )
    } catch (error) {
      if (!(error instanceof PermissionRequestGoneError)) throw error
      this.host.state.pendingPermissions.delete(requestId)
      await this.recordPermissionDecision(pending, resolvedReply, 'user:stale-request')
      // The decision cannot be delivered after the driver's blocking request
      // disappears. Never pretend the turn resumed: terminate it cleanly so a
      // stale approval or rejection cannot leave a tool call spinning forever.
      await this.interruptRejectedPermission(pending, driver)
      Logger.dev(`Reconciled resolved permission request: ${requestId}`)
      return
    }
    await this.recordPermissionDecision(pending, resolvedReply, 'user')
    this.host.state.pendingPermissions.delete(requestId)
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
          []
        )
        this.host.units['temporary-chats'].refreshTemporaryChatExpiry(sideChat)
        return
      }
      // Surface the alternative as a visible user message; the harness already
      // received it as corrective feedback on the permission reply.
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
        alternativeText,
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
    await driver.abort(pending.session.projectPath, sessionId)
  }

  /** List unresolved permission requests for renderer reconnect recovery. */
  async listPermissions(projectId: string, threadId: string): Promise<PermissionRequest[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    const ovenThread = await this.host.threadManager.getThread(projectId, threadId)
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
    const scratchPaths = isAssistant
      ? []
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
    const workspaceRoots = isAssistant ? [resolve(info.projectPath)] : []
    // A thread in a real project also owns that project's `.cio` scratch folder:
    // it is where the agent stages its own work, so deletes and confined shell
    // commands there never prompt. `.cio/specs` and `.cio/git` stay gated inside
    // the policy, because the platform owns those.
    if (!isChat && !isAssistant) {
      scratchPaths.push(resolve(info.projectPath, PROJECT_DATA_DIRECTORY))
      const projectThread = await this.host.threadManager.getThread(info.projectId, info.threadId)
      const workingDirectory = projectThread?.workingDirectory
      if (workingDirectory && resolve(workingDirectory) !== resolve(info.projectPath)) {
        workspaceRoots.push(resolve(workingDirectory))
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

    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    const fileSystemMode = thread?.settings?.fileSystemMode === true
    return {
      allowedPaths: [...attachmentPaths, ...chatSkillPaths(info.driverId)],
      scratchPaths,
      // A chat owns its workspace only once it may write there: with File
      // System off it is restricted to the attached files, so the workspace
      // earns no exemption from the sensitive-file list either.
      workspaceRoots: fileSystemMode ? [resolve(info.projectPath)] : [],
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
      entry.policy = new PermissionPolicy({
        projectRoot: entry.session.projectPath,
        mode: entry.session.permissionLevel ?? 'auto_review',
        sensitiveFileProtectionEnabled: false
      }).evaluate({ permission: entry.request.permission, paths: entry.request.patterns })
      try {
        await this.replyPermissionRaw(entry, 'once', 'settings:sensitive-files-disabled')
      } catch (error) {
        if (!(error instanceof PermissionRequestGoneError)) {
          Logger.error('Could not release a disabled sensitive-file check:', error)
          continue
        }
        this.host.state.pendingPermissions.delete(entry.request.id)
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

  /** Resolve a permission request per the thread's permission level. */
  async handlePermissionAsked(
    driverId: string,
    event: Extract<AgentEvent, { type: 'permission.asked' }>,
    sourceDriver?: HarnessDriver,
    settleBrowserAction?: PendingPermissionInfo['settleBrowserAction'],
    browserReview?: BrowserActionReview
  ): Promise<void> {
    const { sessionId, permission: request } = event
    const info = this.host.sessionRegistry.get(sessionId)
    const level = info?.permissionLevel ?? 'auto_review'
    if (!info) {
      Logger.error('Permission request has no registered session:', request.id)
      return
    }

    const commands = permissionCommands(request.metadata)
    const unclassifiedTool = request.metadata['surface']
    const sensitiveFileProtectionEnabled =
      request.permission !== 'bundled-pi-sensitive-files' ||
      (await this.host.storage.getConfig()).bundledPiSensitiveFileProtectionEnabled !== false
    const { allowedPaths, scratchPaths, workspaceRoots, restrictToAllowed } =
      await this.chatPermissionScope(info)
    let policy = new PermissionPolicy({
      projectRoot: info.projectPath,
      mode: restrictToAllowed ? 'auto_review' : level,
      sensitiveFileProtectionEnabled,
      ...(allowedPaths.length > 0 ? { allowedPaths } : {}),
      ...(scratchPaths.length > 0 ? { scratchPaths } : {}),
      ...(workspaceRoots.length > 0 ? { workspaceRoots } : {}),
      ...(!settleBrowserAction && restrictToAllowed ? { restrictToAllowed } : {})
    }).evaluate({
      permission: request.permission,
      paths: request.patterns.filter((pattern) => !commands.includes(pattern)),
      commands,
      ...(typeof unclassifiedTool === 'string' && unclassifiedTool.trim().length > 0
        ? { unclassifiedTool: unclassifiedTool.trim() }
        : {})
    })
    const thread = await this.host.threadManager.getThread(info.projectId, info.threadId)
    // Only an app-owned browser call may supply this decision. Harness metadata
    // cannot turn an unclassified tool into an automatically approved action.
    const sensitiveFileApproval = request.permission === 'bundled-pi-sensitive-files'
    if (!sensitiveFileApproval && settleBrowserAction && browserReview && level === 'auto_review') {
      // An assistant runs unattended on the browser pages it opens
      // itself, so a card it cannot answer would only park the run. The
      // capability's own effect review still runs and is recorded, but it never
      // escalates to the user for these threads. The browser assistant in the
      // global browser's sidebar keeps asking, because it acts on the page the
      // user is reading and a surprise mutation there is the user's to approve.
      const unattended = thread !== null && isAssistantThread(thread)
      const approved = unattended || browserReview.approved
      const reason = unattended
        ? 'Auto-approved: an assistant acting on a page it opened itself.'
        : browserReview.reason
      const decision = approved ? 'auto_review' : 'ask'
      policy = {
        ...policy,
        approved,
        decision,
        risk: browserReview.risk,
        reason,
        approval: { required: !approved },
        ledger: {
          ...policy.ledger,
          decision,
          risk: browserReview.risk,
          reason
        }
      }
    }
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
      settleBrowserAction,
      resumeStatus
    }
    this.host.state.pendingPermissions.set(request.id, pending)
    this.host.units['turns'].markProjectActive(info.projectId)

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
    }
    if (
      info.projectId === GLOBAL_BROWSER_PROJECT_ID &&
      restrictToAllowed &&
      !settleBrowserAction &&
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
          level === 'full_access' ? 'always' : 'once',
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
    if (pending.settleBrowserAction) {
      if (this.host.state.pendingPermissions.get(pending.request.id) !== pending) return
      await this.recordPermissionDecision(pending, reply, decidedBy)
      if (this.host.state.pendingPermissions.get(pending.request.id) !== pending) return
      const remaining = [...this.host.state.pendingPermissions.values()].some(
        (other) => other !== pending && other.session.sessionId === pending.session.sessionId
      )
      try {
        await this.host.threadManager.setStatus(
          pending.session.projectId,
          pending.session.threadId,
          remaining ? 'awaiting_approval' : pending.resumeStatus
        )
      } catch (error) {
        this.host.state.pendingPermissions.delete(pending.request.id)
        pending.settleBrowserAction(false)
        throw error
      }
      if (this.host.state.pendingPermissions.get(pending.request.id) !== pending) return
      this.host.state.pendingPermissions.delete(pending.request.id)
      this.host.broadcast({
        type: 'permission.replied',
        sessionId: pending.request.sessionId,
        requestId: pending.request.id,
        reply
      })
      pending.settleBrowserAction(reply !== 'reject', alternative)
      return
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
      undefined,
      pending.request.sessionId
    )
    await this.recordPermissionDecision(pending, reply, decidedBy)
    this.host.state.pendingPermissions.delete(pending.request.id)
  }

  clearPendingPermissionsForSession(sessionId: string): void {
    for (const [requestId, pending] of this.host.state.pendingPermissions) {
      if (pending.request.sessionId === sessionId) {
        this.host.state.pendingPermissions.delete(requestId)
        pending.settleBrowserAction?.(false)
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
