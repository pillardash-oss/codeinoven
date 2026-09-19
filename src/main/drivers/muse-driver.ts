/**
 * Muse Code (Meta) headless integration notes.
 *
 * Muse is a terminal-only coding agent whose programmatic surface is
 * `muse exec --json`   a one-shot, headless run that streams newline-delimited
 * JSON on stdout and exits when the turn is done. CodeInOven deliberately runs
 * every turn without Muse-native session history, workspace rules, or skills;
 * the app supplies its own bounded history recap, behavior, memory, and utility
 * context in the explicit prompt.
 *
 * Wire schema: every line is an envelope `{ record_type, payload_type, payload }`.
 * Meaningful payloads:
 *   - `run.output.delta`  → `payload.text` (incremental assistant text)
 *   - `run.output.reasoning.delta` / `run.reasoning.delta` / `run.thinking.delta`
 *     → incremental reasoning trace (`payload.text` / `payload.delta` / `payload.reasoning`)
 *   - `run.terminal.completed` → `payload.terminal` (`completed`|`error`),
 *     `payload.text` (final), `payload.reason`
 *   - `run.model.configured` → `payload.provider_id` / `payload.model_id`
 *   - `task.lifecycle.proposed` → tool call announced (`event.task_kind` `tool.*`)
 *   - `task.lifecycle.side_effect_intent` → tool running + provider call id
 *   - `task.lifecycle.output` → tool chunk (bash `{command,description,output}`)
 *   - `*.compaction*` / `runtime.session` `compaction` → harness-native context
 *     compaction checkpoint (auto when soft/hard threshold hit). Mirrored as a
 *     `compaction` part so `formatHistoryRecap` slices from that cut on the
 *     next turn   seamless continuation.
 *   - `tool.result` → authoritative tool completion (`call_id`, `text`)
 * The provider session UUID is intentionally not reused: every turn runs with
 * a fresh `--session-id`, so Muse-native memory/history stays isolated. The
 * live stdout stream carries no reasoning and (in Muse 1.x) no committed tool
 * arguments, so the driver also tails the durable session log
 * (`~/.local/share/muse/sessions/<date>/<run-uuid>/session.jsonl`) during the
 * turn for the reasoning summary trace and tool-detail backfill.
 * There is no per-record token/usage telemetry.
 *
 * Meta's Muse Code launch documentation also demonstrates a local video file
 * being supplied directly in the terminal and interpreted by Muse Code:
 * https://research.meta.ai/blog/introducing-muse-code-and-muse-spark-1-2
 */
import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import type {
  AgentMessage,
  AgentPart,
  PermissionReply,
  ProviderCatalog,
  ThinkingLevel
} from '../../lib/types'
import { THINKING_LEVEL_ORDER } from '../../lib/thinking-presets'
import { attachmentReference, attachmentTarget } from './attachment-reference'
import { buildProcessEnvironment } from './cli-environment'
import type {
  CliLineParseContext,
  CliLineParseResult,
  CliTurnCommand,
  PersistentCliSession,
  TitleModelCandidate
} from './persistent-cli-driver'
import { PersistentCliDriver } from './persistent-cli-driver'
import type {
  GenerateTitleOptions,
  GradeTurnOptions,
  HarnessCapabilities,
  SendPromptOptions,
  SteerPromptOptions
} from './driver.interface'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import {
  MUSE_PROBE_TIMEOUT_MS,
  museFallbackCatalog,
  readMuseCliCapabilities,
  readMuseModelCatalog,
  runMuse
} from './muse/muse-capabilities'
import {
  findMuseSessionLog,
  MUSE_SESSION_LOG_FIND_TIMEOUT_MS,
  MUSE_SESSION_LOG_POLL_MS,
  MUSE_SESSION_LOG_TAIL_GRACE_MS,
  type MuseSessionLogWatcher
} from './muse/muse-session-log'
import {
  isMuseSubagentSpawn,
  museFinalizeInterruptedTools,
  type MuseTurnState
} from './muse/muse-parts'
import { museToolNeedsPermission, museToolName } from './muse/muse-interactions'
import { escapeMuseMentions, record, stringValue } from './muse/muse-values'
import { mapMuseRecord } from './muse/muse-stream-fold'

export type { MuseTurnState } from './muse/muse-parts'
export { mapMuseRecord } from './muse/muse-stream-fold'

export class MuseDriver extends PersistentCliDriver {
  readonly id = 'muse'
  readonly name = 'Muse Code'
  readonly capabilities: HarnessCapabilities = {
    runtimeTopology: { kind: 'turn_process', scope: 'session' },
    streaming: true,
    steering: true,
    nativeResume: false,
    messageHistory: 'mirrored',
    interactivePermissions: true,
    attachments: true,
    commands: false,
    providerCatalog: true,
    sessionStatus: false,
    contextUsage: false,
    compaction: true,
    subagents: true,
    nativeUtilities: []
  }

  private turnStates = new Map<string, MuseTurnState>()
  private continuationOptions = new Map<string, SendPromptOptions>()
  private approvedToolAllowances = new Map<string, number>()
  private hiddenContinuationSessions = new Set<string>()
  private sessionLogWatchers = new Map<string, MuseSessionLogWatcher>()
  /**
   * Steers received while a tool call is mid-flight (e.g. a running shell
   * command). Muse's `exec` process cannot accept live input, so a steer
   * always restarts the turn   but restarting immediately would kill the
   * tool call itself. Queue it here and deliver once `onJsonRecord` observes
   * the tool call settle (`tool.result`), or the process exits for any other
   * reason. The user's message is already visible in the transcript via
   * chat-engine's optimistic persist, so this only delays transport, not
   * display.
   */
  private pendingSteers = new Map<string, { projectPath: string; options: SteerPromptOptions }[]>()

  constructor(storage: StorageEngine) {
    super(storage)
  }

  /**
   * Incrementally tail the Muse session log for the active turn. Muse 1.x
   * headless stdout never carries the reasoning summary or committed tool-call
   * arguments; they are only written to the durable session log
   * (`~/.local/share/muse/sessions/<date>/<run-uuid>/session.jsonl`) while the
   * run is in flight. The tailer replays new records through the standard
   * record mapper so the working trace renders live thinking and complete tool
   * details, and backfills tool cards when the live stream missed a record.
   */
  private startSessionLogWatcher(
    sessionId: string,
    turnState: MuseTurnState,
    session: PersistentCliSession,
    projectPath: string,
    museSessionId: string
  ): void {
    this.stopSessionLogWatcher(sessionId)
    const watcher: MuseSessionLogWatcher = {
      turnState,
      session,
      projectPath,
      museSessionId,
      logPath: null,
      offset: 0,
      pending: '',
      giveUpAfter: Date.now() + MUSE_SESSION_LOG_FIND_TIMEOUT_MS,
      timer: null,
      stopTimer: null,
      stopping: false
    }
    watcher.timer = setInterval(() => {
      void this.pollSessionLog(sessionId, watcher)
    }, MUSE_SESSION_LOG_POLL_MS)
    this.sessionLogWatchers.set(sessionId, watcher)
  }

  private stopSessionLogWatcher(sessionId: string): void {
    const watcher = this.sessionLogWatchers.get(sessionId)
    if (!watcher) return
    if (watcher.timer) clearInterval(watcher.timer)
    if (watcher.stopTimer) clearTimeout(watcher.stopTimer)
    this.sessionLogWatchers.delete(sessionId)
  }

  /** Keep tailing briefly after process exit to catch Muse's final flushes. */
  private scheduleSessionLogWatcherStop(sessionId: string): void {
    const watcher = this.sessionLogWatchers.get(sessionId)
    if (!watcher || watcher.stopTimer) return
    watcher.stopping = true
    watcher.stopTimer = setTimeout(() => {
      this.stopSessionLogWatcher(sessionId)
    }, MUSE_SESSION_LOG_TAIL_GRACE_MS)
  }

  private async pollSessionLog(sessionId: string, watcher: MuseSessionLogWatcher): Promise<void> {
    if (this.turnStates.get(sessionId) !== watcher.turnState) {
      this.stopSessionLogWatcher(sessionId)
      return
    }
    try {
      if (!watcher.logPath) {
        if (Date.now() > watcher.giveUpAfter) {
          this.stopSessionLogWatcher(sessionId)
          return
        }
        watcher.logPath = await findMuseSessionLog(watcher.museSessionId)
        if (!watcher.logPath) return
      }
      const handle = await open(watcher.logPath, 'r')
      try {
        const stat = await handle.stat()
        if (stat.size <= watcher.offset) return
        const buffer = Buffer.alloc(stat.size - watcher.offset)
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, watcher.offset)
        watcher.offset += bytesRead
        watcher.pending += buffer.toString('utf8')
      } finally {
        await handle.close()
      }
      const lines = watcher.pending.split(/\r?\n/u)
      watcher.pending = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let value: unknown
        try {
          value = JSON.parse(trimmed) as unknown
        } catch {
          continue
        }
        // The session log replays records through the same mapper; the
        // runtime.session handlers backfill reasoning and tool details while
        // everything else is ignored, so replay is safe.
        const result = this.parseJsonLine(value, {
          session: watcher.session,
          sessionId,
          projectPath: watcher.projectPath
        })
        if (result) this.applyParseResult(result, watcher.session)
      }
    } catch {
      // The log appears after the run starts and may rotate; retry silently
      // until the watcher gives up. Failures here must never break the turn.
    }
  }

  dispose(): void {
    for (const sessionId of [...this.sessionLogWatchers.keys()]) {
      this.stopSessionLogWatcher(sessionId)
    }
    this.turnStates.clear()
    this.continuationOptions.clear()
    this.approvedToolAllowances.clear()
    this.hiddenContinuationSessions.clear()
    super.dispose()
  }

  protected async ensureCliReady(): Promise<void> {
    const result = await runMuse(['--version'], MUSE_PROBE_TIMEOUT_MS)
    if (!result.succeeded) {
      const detail = result.stderr.trim() || result.stdout.trim() || 'unknown error'
      throw new Error(`Muse Code CLI is unavailable: ${detail}`)
    }
  }

  async listProviders(): Promise<ProviderCatalog[]> {
    const capabilities = await readMuseCliCapabilities()
    const discovered = await readMuseModelCatalog(capabilities)
    return discovered.length > 0 ? discovered : museFallbackCatalog(capabilities)
  }

  /** First available catalog model, shared by title and grading runs. */
  private async cheapestCandidate(): Promise<TitleModelCandidate[]> {
    const providers = await this.listProviders()
    const model = providers[0]?.models[0]
    return model ? [{ providerId: model.providerId, modelId: model.id }] : []
  }

  async generateTitle(projectPath: string, options: GenerateTitleOptions): Promise<string | null> {
    return this.generateTitleWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapestCandidate())
    )
  }

  async gradeTurn(projectPath: string, options: GradeTurnOptions): Promise<number | null> {
    return this.gradeTurnWithCandidates(
      projectPath,
      options,
      options.candidates ?? (await this.cheapestCandidate())
    )
  }

  /** Cheapest candidates for any auxiliary one-shot run. */
  protected override async cheapCandidateModels(): Promise<TitleModelCandidate[]> {
    return this.cheapestCandidate()
  }

  protected async buildTurnCommand(
    _projectPath: string,
    session: PersistentCliSession,
    options: SendPromptOptions
  ): Promise<CliTurnCommand> {
    // A fresh Muse session UUID per turn keeps Muse-native memory and history
    // isolated (CodeInOven supplies its own recap) while still enabling the
    // durable session log   the only place Muse 1.x persists the reasoning
    // summary trace and committed tool-call details for headless runs.
    const museSessionId = randomUUID()
    const args: string[] = [
      'exec',
      '--json',
      '--no-foreign-personal-context',
      '--session-id',
      museSessionId,
      '--user-input-auto-resolve'
    ]
    if (options.settings.providerId && options.settings.providerId !== 'default') {
      args.push('--provider', options.settings.providerId)
    }
    if (options.settings.modelId && options.settings.modelId !== 'default') {
      args.push('--model', options.settings.modelId)
    }
    const cliCapabilities = await readMuseCliCapabilities()
    const requestedThinkingIndex = THINKING_LEVEL_ORDER.indexOf(options.settings.thinkingLevel)
    const reasoningEffort = cliCapabilities.reasoningEfforts.reduce<ThinkingLevel | undefined>(
      (closest, candidate) => {
        if (!closest) return candidate
        const candidateDistance = Math.abs(
          THINKING_LEVEL_ORDER.indexOf(candidate) - requestedThinkingIndex
        )
        const closestDistance = Math.abs(
          THINKING_LEVEL_ORDER.indexOf(closest) - requestedThinkingIndex
        )
        return candidateDistance <= closestDistance ? candidate : closest
      },
      undefined
    )
    if (reasoningEffort) args.push('--reasoning-effort', reasoningEffort)

    if (options.readOnly) {
      // Inspection chats must not mutate the workspace.
      args.push('--disable-write')
    } else if (options.settings.permissionLevel === 'full_access') {
      // Full Access trusts the workspace and bypasses approval and the sandbox.
      args.push('--yolo')
    } else {
      args.push('--disable-approval')
    }

    // Native automatic compaction keeps the provider context window bounded
    // even for this stateless harness (mirrored history + recap).
    args.push(
      '--context-compaction-strategy',
      'summary-preserved-suffix/v1',
      '--context-compaction-soft-threshold',
      '0.8',
      '--context-compaction-hard-threshold',
      '0.95'
    )

    // Subagents share the CodeInOven-managed worktree/scope. Do not
    // pass `--subagent-worktree-isolation`   CodeInOven owns the Git
    // worktree lifecycle (`ScopeWorktreeService`); harness-owned worktrees
    // are intentionally disabled. `subagent_spawn` without `worktree_isolation:true` stays shared;
    // any affirmative `worktree_isolation:true` is normalized to `false` (shared) before execution.
    // `worktree_isolation:false` stays shared by default.

    const attachmentReferences: string[] = []
    for (const attachment of options.attachments) {
      if (attachment.mime.toLocaleLowerCase().startsWith('image/')) {
        if (!cliCapabilities.attachments) {
          throw new Error('The installed Muse Code CLI does not advertise image attachments')
        }
        const target = await attachmentTarget(attachment)
        if (/^(?:data:|https?:\/\/)/u.test(target)) {
          throw new Error(
            `Muse Code requires a local image file for prompt attachments: ${attachment.filename ?? 'image'}`
          )
        }
        // `muse exec` exposes a repeatable --image input for local image files.
        args.push('--image', target)
      } else {
        attachmentReferences.push(await attachmentReference(attachment))
      }
    }

    const prompt = [
      options.systemPrompt,
      attachmentReferences.join('\n\n'),
      escapeMuseMentions(options.text)
    ]
      .filter(Boolean)
      .join('\n\n')
    args.push(prompt)

    const turnIndex = session.messages.filter((message) => message.role === 'assistant').length + 1
    const turnState: MuseTurnState = {
      turnIndex,
      messageId: `muse:${session.id}:${turnIndex}`,
      createdAt: Date.now(),
      text: '',
      reasoning: '',
      reasoningTime: { start: Date.now() },
      parts: [],
      started: false,
      tools: new Map(),
      toolByCall: new Map(),
      promotedInteractions: new Set(),
      emittedPermissionTasks: new Set(),
      gatedTaskIds: new Set(),
      expectsProcessStop: false
    }
    this.turnStates.set(session.id, turnState)
    this.continuationOptions.set(session.id, {
      ...options,
      settings: { ...options.settings },
      attachments: [...options.attachments]
    })
    // Muse 1.x never streams the reasoning summary or committed tool-call
    // arguments on headless stdout   they are only persisted to the durable
    // session log. Tail that log for the duration of the turn so the working
    // trace shows live thinking and complete tool details.
    this.startSessionLogWatcher(session.id, turnState, session, _projectPath, museSessionId)
    return {
      command: 'muse',
      args,
      env: buildProcessEnvironment(),
      onJsonRecord: (value) => {
        const envelope = record(value)
        const payloadType = envelope?.['payload_type']
        const payload = record(envelope?.['payload'])

        if (
          options.settings.permissionLevel !== 'full_access' &&
          payloadType === 'task.lifecycle.proposed'
        ) {
          const event = record(payload?.['event'])
          const taskId = stringValue(payload?.['task_id'])
          const taskKind = museToolName(event?.['task_kind'], 'task_kind')
          if (
            taskId &&
            taskKind &&
            !isMuseSubagentSpawn(taskKind) &&
            museToolNeedsPermission(taskKind)
          ) {
            const allowance = this.approvedToolAllowances.get(session.id) ?? 0
            if (allowance > 0) {
              if (allowance === 1) this.approvedToolAllowances.delete(session.id)
              else this.approvedToolAllowances.set(session.id, allowance - 1)
            } else {
              turnState.gatedTaskIds.add(taskId)
              turnState.expectsProcessStop = true
              this.stopActiveProcess(session.id)
              return
            }
          }
        }

        // A tool call just settled (its authoritative completion signal)   if a
        // steer is queued and no other tool call is still in flight, this is
        // the safe boundary to deliver it at.
        if (payloadType === 'tool.result') {
          const callId = stringValue(payload?.['call_id'])
          const settlingTaskId = callId ? turnState.toolByCall.get(callId) : undefined
          const stillActive = [...turnState.tools.entries()].some(
            ([taskId, tool]) =>
              taskId !== settlingTaskId &&
              !turnState.gatedTaskIds.has(taskId) &&
              (tool.status === 'pending' || tool.status === 'running')
          )
          if (!stillActive) this.deliverPendingSteers(session.id)
        }
      },
      suppressIdle: () => turnState.promotedInteractions.size > 0,
      isExpectedExit: () => turnState.expectsProcessStop,
      onProcessExit: () => {
        this.approvedToolAllowances.delete(session.id)
        // Finalize tool cards that outlived the process (killed for a
        // permission gate or steering while a sibling call was mid-flight) so
        // they never spin forever with empty details.
        const finalizeEvents = museFinalizeInterruptedTools(
          { session, sessionId: session.id, projectPath: _projectPath },
          turnState
        )
        if (finalizeEvents.length > 0) {
          this.applyParseResult({ events: finalizeEvents }, session)
        }
        // Stop the session-log tailer after a short grace so the final records
        // Muse flushes at exit (reasoning summary commit, result batch) are
        // still captured.
        this.scheduleSessionLogWatcherStop(session.id)
        // Fallback for turns that never produced a tool-call boundary (a
        // plain-text reply, or the process exiting before one settled)   a
        // steer queued against this turn would otherwise never be delivered.
        this.deliverPendingSteers(session.id)
      }
    }
  }

  override async steerPrompt(projectPath: string, options: SteerPromptOptions): Promise<void> {
    const turnState = this.turnStates.get(options.sessionId)
    const hasActiveTool = turnState
      ? [...turnState.tools.values()].some(
          (tool) =>
            !turnState.gatedTaskIds.has(tool.taskId) &&
            (tool.status === 'pending' || tool.status === 'running')
        )
      : false
    if (turnState) turnState.expectsProcessStop = true
    if (!hasActiveTool) {
      await super.steerPrompt(projectPath, options)
      return
    }
    const queue = this.pendingSteers.get(options.sessionId) ?? []
    queue.push({ projectPath, options })
    this.pendingSteers.set(options.sessionId, queue)
  }

  /** Deliver every steer queued for a session as one merged, deferred steer. */
  private deliverPendingSteers(sessionId: string): void {
    const queue = this.pendingSteers.get(sessionId)
    if (!queue || queue.length === 0) return
    this.pendingSteers.delete(sessionId)
    // Delivering the queued steer requires SIGTERM-ing the still-running turn
    // process (exit code 143 + Muse's shutdown banner on stderr). Mark the stop
    // as deliberate so `isExpectedExit` suppresses the bogus crash error and
    // steering stays seamless like native-streaming harnesses.
    const turnState = this.turnStates.get(sessionId)
    if (turnState) turnState.expectsProcessStop = true
    const last = queue[queue.length - 1]
    const merged: SteerPromptOptions = {
      ...last.options,
      text: queue.map((entry) => entry.options.text).join('\n\n'),
      attachments: queue.flatMap((entry) => entry.options.attachments)
    }
    super.steerPrompt(last.projectPath, merged).catch((error: unknown) => {
      Logger.error(`Muse deferred steer failed for session ${sessionId}:`, error)
    })
  }

  override async replyPermission(
    projectPath: string,
    requestId: string,
    reply: PermissionReply,
    message?: string,
    sessionId?: string
  ): Promise<void> {
    if (!sessionId) throw new Error(`Muse permission request is no longer pending: ${requestId}`)
    const action =
      reply === 'reject'
        ? message
          ? `The user rejected the requested action and supplied this alternative:\n${message}`
          : 'The user rejected the requested action. Do not execute it. Continue safely without that action, or explain why the task cannot continue.'
        : `The user approved the requested action through CodeInOven (${reply}). Execute only that approved action, then continue. Ask again before any different action that requires approval.`
    if (reply === 'reject') {
      await this.continueInteraction(projectPath, sessionId, action)
      return
    }
    this.approvedToolAllowances.set(sessionId, 1)
    try {
      await this.continueInteraction(projectPath, sessionId, action)
    } catch (error) {
      this.approvedToolAllowances.delete(sessionId)
      throw error
    }
  }

  override async replyToQuestion(
    projectPath: string,
    sessionId: string,
    _requestId: string,
    answers: string[][]
  ): Promise<void> {
    const formatted = answers
      .map((values, index) => `${index + 1}. ${values.join(', ')}`)
      .join('\n')
    await this.continueInteraction(
      projectPath,
      sessionId,
      `The user answered Muse's earlier request_user_input prompt through CodeInOven:\n${formatted}\nContinue from these answers without asking the same question again.`
    )
  }

  override async rejectQuestion(
    projectPath: string,
    sessionId: string,
    _requestId: string
  ): Promise<void> {
    await this.continueInteraction(
      projectPath,
      sessionId,
      "The user dismissed Muse's earlier request_user_input prompt. Continue without that answer, or explain why the task cannot continue."
    )
  }

  private async continueInteraction(
    projectPath: string,
    sessionId: string,
    text: string
  ): Promise<void> {
    const options = this.continuationOptions.get(sessionId)
    if (!options) throw new Error(`Muse interaction session is unavailable: ${sessionId}`)
    const continuationText = [
      'Continue this CodeInOven-managed task without relying on Muse session memory.',
      `Active task context:\n${options.text}`,
      `New interaction result:\n${text}`
    ].join('\n\n')
    this.hiddenContinuationSessions.add(sessionId)
    try {
      // The gated run was stopped (or is paused waiting on an interaction
      // prompt). Await the process settlement so resuming never collides with
      // the still-active turn ("A turn is already active")   same teardown
      // contract steerPrompt relies on.
      await this.settleActiveProcess(sessionId)
      await this.sendPrompt(projectPath, {
        ...options,
        sessionId,
        text: continuationText,
        attachments: [...options.attachments]
      })
    } finally {
      this.hiddenContinuationSessions.delete(sessionId)
    }
  }

  protected override appendUserMessage(
    session: PersistentCliSession,
    options: Pick<SendPromptOptions, 'text' | 'attachments' | 'userMessageId'>
  ): void {
    super.appendUserMessage(session, options)
    if (!this.hiddenContinuationSessions.has(session.id)) return
    const message = session.messages.findLast((candidate) => candidate.role === 'user')
    if (message) message.visibility = 'hidden'
  }

  protected parseJsonLine(value: unknown, context: CliLineParseContext): CliLineParseResult | null {
    const state = this.turnStates.get(context.sessionId)
    if (!state) return null
    return mapMuseRecord(value, context, state)
  }

  async compactSession(
    projectPath: string,
    sessionId: string,
    _settings: import('../../lib/types').ThreadSettings
  ): Promise<void> {
    void _settings
    const session = await this.requireSession(projectPath, sessionId)
    if (session.messages.length === 0) {
      throw new Error('No messages to compact for this thread')
    }
    const messageId = `${sessionId}:compaction:${Date.now()}`
    const partId = `${messageId}:compaction`
    const summary = this.buildLocalCompactionSummary(session.messages)
    const compactionPart: Extract<AgentPart, { type: 'compaction' }> = {
      type: 'compaction',
      id: partId,
      messageID: messageId,
      auto: false,
      summary
    }
    session.messages.push({
      id: messageId,
      role: 'assistant',
      parts: [compactionPart],
      createdAt: Date.now(),
      harnessId: this.id
    })

    this.emit({ type: 'session.status', sessionId, status: { state: 'working' } })
    this.applyEventToSession(session, {
      type: 'message.part.updated',
      sessionId,
      part: compactionPart
    })
    this.emit({ type: 'message.part.updated', sessionId, part: compactionPart })
    await this.persistSession(session)

    this.applyEventToSession(session, {
      type: 'message.completed',
      sessionId,
      messageId,
      compaction: true
    })
    this.emit({ type: 'message.completed', sessionId, messageId, compaction: true })
    this.emit({ type: 'session.idle', sessionId })
    await this.persistSession(session)
  }

  private buildLocalCompactionSummary(messages: AgentMessage[]): string {
    const transcript = messages
      .map((message) => {
        const text = message.parts
          .flatMap((part) => {
            if (part.type === 'text') return [part.text]
            if (
              part.type === 'compaction' &&
              typeof part.summary === 'string' &&
              part.summary.trim()
            )
              return [`[Prior compaction] ${part.summary.trim()}`]
            if (part.type === 'compaction-summary' && typeof part.text === 'string')
              return [`[Prior compaction] ${part.text.trim()}`]
            return []
          })
          .join('\n')
          .trim()
        if (!text) return ''
        const role = message.role === 'user' ? 'USER' : 'ASSISTANT'
        return `${role}: ${text}`
      })
      .filter(Boolean)
      .join('\n\n')
    const maxChars = 12_000
    const truncated = transcript.length > maxChars ? transcript.slice(-maxChars) : transcript
    const header = `Manual compaction of ${messages.length} messages. Older context summarized below; the next turn replays only this summary plus suffix per summary-preserved-suffix/v1.`
    return truncated ? `${header}\n\n${truncated}` : header
  }
}
