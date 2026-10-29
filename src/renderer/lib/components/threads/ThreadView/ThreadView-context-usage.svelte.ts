import type { ComposerIdentity } from '../../chats/ComposerIdentity.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { createAccountUsageCache } from '$lib/stores/account-usage.svelte'
import { getProjectIcon } from '$lib/project-icons'
import { normalizeFastInference } from '$shared/fast-inference'
import { invoke } from '$lib/ipc.svelte'
import { isCodeInOvenCustomProviderId } from '$shared/custom-provider-id'
import { clearIndependentAuditIntent } from '$lib/stores/lifecycle-intent'
import { normalizeChatSettings } from '$lib/stores/thread-settings.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { browserAssistant } from '$lib/stores/browser-assistant.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import {
  coordinatorDockState,
  type CoordinatorDockPanel
} from '$lib/stores/coordinator-dock.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { modelKey } from '$lib/model-keys'
import { ASSISTANT_SPACE_ID, GLOBAL_BROWSER_PROJECT_ID } from '$shared/types'
import type {
  Thread,
  ThreadSettings,
  ThreadContextUsage,
  AgentMessage,
  AgentContextUsage,
  Project,
  AuditReport
} from '$shared/types'
import { mergeContextUsage } from '../thread-usage-merge'
import type { ThreadView } from './ThreadView-board.svelte'
import { DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewContextUsage {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root) throw new Error('ThreadViewContextUsage read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }

  /** Reads the audit settings once the board can resolve them. */
  bindAuditSettings(): void {
    this.auditSettings = this.root.sources.auditSettingsForThread()
  }
  project = $state<Project | null>(null)

  /**
   * What the composer is writing into, which the shoe names once.
   *
   * The thread's own project id already says what it is: the assistant space
   * holds assistant tasks and their runs, the hidden browser container holds one
   * conversation per browser tab, and everything else is a project thread   or a
   * plain chat, which is what a chat in the chats view is: a conversation with no
   * project, no assistant and no page behind it.
   */
  composerIdentity(target: Thread, isNewThread: boolean): ComposerIdentity {
    // A temporary chat is a conversation of its own, not a thread of the project
    // it was opened from. Its thread carries that project's id only because that
    // is where its files are read from, so the space checks below would name it
    // as one of that space's assistant tasks: the assistant mark and the side
    // chat's own title in place of what it actually is.
    if (this.root.loadOlderMessages.hasController) return { kind: 'chat', temporary: true }
    if (target.projectId === ASSISTANT_SPACE_ID) {
      // A run inherits its task's assistant, so this resolves for a task and each
      // of its runs alike; an assistant-less task is named by itself.
      const assistant = assistants.assistantForTask(target)
      if (assistant) return { kind: 'assistant', assistant }
      return { kind: 'task', task: target }
    }
    if (target.projectId === GLOBAL_BROWSER_PROJECT_ID) {
      const tabId = browserAssistant.chatForThread(target.id)?.browserTabId
      if (tabId) return { kind: 'browser-tab', tabId }
      return { kind: 'chat' }
    }
    if (!this.root.props.chatMode && this.project) {
      return {
        kind: 'project',
        activeProjectId: target.projectId,
        project: {
          name: this.project.name,
          path: this.project.path,
          source: this.project.source,
          host: this.project.host,
          iconUrl: getProjectIcon(
            this.project,
            this.root.switchProject.projectIconUrl ?? undefined
          ),
          branch: target.branch
        },
        interactive: isNewThread,
        onSwitchProject: (pid: string) => void this.root.switchProject.switchProject(pid)
      }
    }
    return { kind: 'chat' }
  }

  contextUsage = $derived.by((): AgentContextUsage | undefined => {
    let latestMessage: AgentMessage | undefined
    let latestTokens: NonNullable<AgentContextUsage['tokens']> | undefined
    let latestReportedContextUsed: number | undefined
    let latestEstimatedContextUsed: number | undefined
    let latestRateLimits: AgentContextUsage['rateLimits'] | undefined
    let latestCredits: AgentContextUsage['credits'] | undefined
    let costUsd = 0
    // The harness's own session-cumulative spend (pi reports it on every usage
    // refresh). Preferred over the per-message sum when present, because the
    // loaded transcript can be a page while this covers the whole session.
    let latestSessionCostUsd: number | undefined

    const emptyTokens: NonNullable<AgentContextUsage['tokens']> = {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0
    }

    for (const message of this.root.loadOlderMessages.messages) {
      if (message.role !== 'assistant') continue
      // Usage belongs to the harness/provider that reported it. Do not carry
      // cost, context, tokens, or quota across a harness switch; records with
      // unknown provenance are intentionally excluded from the live meter.
      if (
        message.harnessId !== this.root.loadOlderMessages.settings.harnessId ||
        message.providerId !== this.root.loadOlderMessages.settings.providerId
      )
        continue
      // A compaction summary rewrites the harness's context: occupancy and
      // token totals reported by earlier messages no longer describe the
      // session. Drop them here so the meter never shows a stale
      // pre-compaction reading (e.g. a stuck "≈100%")   the next reported
      // or estimated turn re-seeds the signal from the compacted context.
      if (
        message.origin === 'compaction' ||
        message.parts.some((part) => part.type === 'compaction-summary')
      ) {
        latestReportedContextUsed = undefined
        latestEstimatedContextUsed = undefined
        latestTokens = undefined
      }
      latestMessage = message
      const stepCost = message.parts.reduce(
        (total, part) => total + (part.type === 'step-finish' ? (part.cost ?? 0) : 0),
        0
      )
      costUsd += message.cost ?? stepCost
      if (message.sessionCostUsd !== undefined) latestSessionCostUsd = message.sessionCostUsd
      // Prefer the message-level (whole-turn) usage the harness reports; while
      // a turn is still streaming, sum every completed step so the indicator
      // grows monotonically instead of bouncing between per-step token counts
      // on each tool call.
      const cumulativeSteps = message.parts.reduce(
        (total, part): NonNullable<AgentContextUsage['tokens']> => {
          if (part.type !== 'step-finish' || !part.tokens) return total
          return {
            input: total.input + part.tokens.input,
            output: total.output + part.tokens.output,
            reasoning: total.reasoning + part.tokens.reasoning,
            cacheRead: total.cacheRead + part.tokens.cacheRead,
            cacheWrite: total.cacheWrite + part.tokens.cacheWrite,
            total: total.total + part.tokens.total
          }
        },
        emptyTokens
      )
      const tokens =
        message.tokens && message.tokens.total > 0
          ? message.tokens
          : cumulativeSteps.total > 0
            ? cumulativeSteps
            : undefined
      const hasUsageSnapshot =
        tokens !== undefined ||
        message.contextUsed !== undefined ||
        (message.rateLimits?.length ?? 0) > 0 ||
        message.credits !== undefined
      if (hasUsageSnapshot) {
        // Token, context, and account quota telemetry arrive independently.
        // Preserve each latest snapshot so a token-only update cannot erase a
        // previously reported quota status when the user reveals live usage.
        // Context occupancy is kept in two tracks: a provider-reported reading
        // always wins over an estimated one, so a late estimate (or an older
        // transcript where the estimate flag was lost) can never drag the
        // meter down from the real occupancy the provider reported.
        if (tokens) latestTokens = tokens
        if (message.contextUsed !== undefined) {
          if (message.contextEstimated === true) {
            if (latestReportedContextUsed === undefined) {
              latestEstimatedContextUsed = message.contextUsed
            }
          } else {
            latestReportedContextUsed = message.contextUsed
            latestEstimatedContextUsed = undefined
          }
        }
        if (message.rateLimits?.length) latestRateLimits = message.rateLimits
        if (message.credits) latestCredits = message.credits
      }
    }

    if (!latestMessage) return undefined
    // The selected model's account-accurate window outranks whatever the latest
    // turn reported: a live harness session keeps reporting the window it
    // started with, so a model (or account) switch would otherwise keep driving
    // the meter with the previous window.
    const contextWindow =
      this.root.currentWorkingTraceAttribution.configuredContextWindow ??
      latestMessage.contextWindow
    // Only the explicit composed-request estimate is an estimate. Falling back
    // to the harness's own reported token total is a provider reading   the
    // last request's prompt plus completion is the occupancy the provider
    // actually processed   so it must never wear the "this harness does not
    // report context telemetry" caveat while the turn is still running.
    const contextEstimated =
      latestReportedContextUsed === undefined && latestEstimatedContextUsed !== undefined
    const contextUsed =
      latestReportedContextUsed ?? latestEstimatedContextUsed ?? latestTokens?.total
    const displayCostUsd = latestSessionCostUsd ?? costUsd
    if (
      contextWindow === undefined &&
      contextUsed === undefined &&
      latestTokens === undefined &&
      latestRateLimits === undefined &&
      latestCredits === undefined &&
      displayCostUsd <= 0
    ) {
      return undefined
    }
    return {
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextUsed === undefined ? {} : { contextUsed }),
      ...(contextUsed !== undefined && contextEstimated ? { contextEstimated: true } : {}),
      ...(contextWindow !== undefined && contextUsed !== undefined
        ? { contextPercent: Math.min(100, (contextUsed / contextWindow) * 100) }
        : {}),
      costUsd: displayCostUsd,
      ...(latestTokens ? { tokens: latestTokens } : {}),
      rateLimits: latestRateLimits ?? [],
      ...(latestCredits ? { credits: latestCredits } : {})
    }
  })

  /** Snapshot of usage actually rendered   it settles at the end of a turn or
   *  after a quiet period, and flushes to the latest value on hover. */
  contextUsageDisplay = $state<AgentContextUsage | undefined>(undefined)

  commitContextUsage(usage: AgentContextUsage): void {
    this.contextUsageDisplay = usage
    this.root.unmirroredTraceStartTime.contextUsageCommittedAt = Date.now()
    const snapshot: ThreadContextUsage = {
      ...usage,
      harnessId: this.root.loadOlderMessages.settings.harnessId,
      providerId: this.root.loadOlderMessages.settings.providerId,
      modelId: this.root.loadOlderMessages.settings.modelId
    }
    // Persist with the thread so the next mount restores instantly. Fire and
    // forget   the live value is already displayed; a failed write only delays
    // the next seed.
    void invoke(
      'thread:setContextUsage',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      snapshot
    ).catch(() => {})
  }

  /** Live quota fetched from the harnesses; layered over message data so old
   *  threads (or threads whose turns predate quota capture) still show current
   *  rate-limit windows and credits in the battery popover. One entry per
   *  harness used on the thread. */
  accountUsageCache = createAccountUsageCache()

  revealContextUsage(): void {
    if (this.contextUsage) this.commitContextUsage(this.contextUsage)
    void this.root.studioTemporaryChatContext.refreshEfficiencyKpis()
    // Fetch live quota only when the battery is revealed (hover), and only if
    // the cached copy is stale   never on thread open.
    if (this.accountUsageCache.isStale()) void this.refreshAccountUsageOnDemand()
  }

  async refreshAccountUsageOnDemand(): Promise<void> {
    // Drop a response for a harness selection the user already moved away
    // from   an out-of-order resolve must not clobber the current selection.
    const refreshKey = `${this.root.loadOlderMessages.settings.harnessId}:${this.root.loadOlderMessages.settings.accountId ?? ''}:${this.root.loadOlderMessages.settings.providerId}`
    const usageList = await this.accountUsageCache.refresh(
      {
        harnessId: this.root.loadOlderMessages.settings.harnessId,
        providerId: this.root.loadOlderMessages.settings.providerId,
        accountId: this.root.loadOlderMessages.settings.accountId
      },
      () =>
        refreshKey !==
        `${this.root.loadOlderMessages.settings.harnessId}:${this.root.loadOlderMessages.settings.accountId ?? ''}:${this.root.loadOlderMessages.settings.providerId}`
    )
    const currentUsage = usageList.find(
      (usage) =>
        usage.harnessId === this.root.loadOlderMessages.settings.harnessId &&
        usage.accountId ===
          (isCodeInOvenCustomProviderId(this.root.loadOlderMessages.settings.providerId)
            ? this.root.loadOlderMessages.settings.providerId
            : (this.root.loadOlderMessages.settings.accountId ??
              `${this.root.loadOlderMessages.settings.harnessId}.default`)) &&
        usage.providerId === this.root.loadOlderMessages.settings.providerId
    )
    if (currentUsage) {
      // Fold the fresh quota over whatever the meter already shows so an empty
      // rate-limit list or missing credits can never erase the bars the user is
      // viewing   it can only replace them with newer, richer data.
      const merged = mergeContextUsage(this.contextUsageDisplay, {
        ...(this.contextUsageDisplay ?? {
          costUsd: 0,
          rateLimits: []
        }),
        rateLimits: currentUsage.rateLimits,
        // A harness reading only supplies the window when the app has none for
        // this model   a live session's stale window must never replace the
        // window the user just configured.
        ...(this.root.currentWorkingTraceAttribution.configuredContextWindow === undefined &&
        currentUsage.contextWindow !== undefined
          ? { contextWindow: currentUsage.contextWindow }
          : {}),
        ...(currentUsage.contextUsed !== undefined
          ? { contextUsed: currentUsage.contextUsed }
          : {}),
        ...(currentUsage.credits ? { credits: currentUsage.credits } : {})
      })
      // Persist the fresh quota with the current context snapshot so it
      // restores on the next mount without another harness round-trip.
      this.commitContextUsage(merged)
    }
  }

  durableAuditThread = $state<Thread | undefined>()

  auditReport = $state<AuditReport | null>(null)

  /** Set by `bind()`: the settings the audit card reads. */
  auditSettings = $state<ThreadSettings>(DEFAULT_SETTINGS)

  // The coordinator is a sidebar tool, not a floating panel: the thread owns the
  // data and the callbacks, so it publishes the panel as a snippet and the
  // context dock renders it. Only the coordination kind is tracked here, so a
  // task update never re-mounts the panel.
  // The coordinator is a sidebar tool, not a floating panel: the thread owns the
  // data and the callbacks, so it publishes the panel data and the context dock
  // renders the matching component. The sidebar picks the component from the
  // registration, so a task update or a worker/auditor switch updates props
  // instead of remounting the panel.
  coordinatorPanel(kind: 'assignment' | 'achievement' | 'audit'): CoordinatorDockPanel | null {
    // Only an orchestration child carries the way back to the Sr. Engineer.
    const onBackToCoordinator = this.root.currentWorkingTraceAttribution.coordinatorParentId
      ? this.root.currentWorkingTraceAttribution.openCoordinatorParent
      : undefined
    if (kind === 'assignment') {
      const activeAssignment = this.root.submitSpecDecision.assignment
      if (!activeAssignment) return null
      return {
        component: 'assignment',
        props: {
          assignment: activeAssignment,
          threads: this.root.currentWorkingTraceAttribution.assignmentThreads,
          auditThread: this.root.buildSpecActionPrompt.assignmentAuditThread,
          auditState: this.root.buildSpecActionPrompt.assignmentAuditState,
          finalComplete: this.root.unmirroredTraceStartTime.assignmentFinalComplete,
          reportAvailable: this.root.unmirroredTraceStartTime.assignmentReportAvailable,
          selectedThreadId: this.root.handleAgentEvent.thread.id,
          coordinatorWorking:
            this.root.switchProject.busy || this.root.buildSpecActionPrompt.delegatedWorkBusy,
          onOpenAssignment: () => {
            if (!this.root.currentWorkingTraceAttribution.openOwnerStudio('assignment'))
              this.root.submitSpecDecision.openAssignmentStudio()
          },
          onOpenAuditWork: this.root.buildSpecActionPrompt.openAssignmentAuditWork,
          onViewReport: () => {
            if (!this.root.currentWorkingTraceAttribution.openOwnerStudio('audit'))
              this.openAuditStudio()
          },
          onOpenThread: (worker) => workspaceState.openThread(worker, this.project),
          onOpenTask: this.root.currentWorkingTraceAttribution.openAssignmentTask,
          onResume: this.root.submitSpecDecision.resumeAssignmentCoordination,
          onStop: this.root.submitSpecDecision.stopAssignment,
          onResumeAssignment: this.root.submitSpecDecision.resumeStoppedAssignment,
          onBackToCoordinator,
          onReportToCoordinator: this.root.currentWorkingTraceAttribution
            .workerCanReportToCoordinator
            ? this.root.submitBrainstormDecision.reportWorkerToCoordinator
            : undefined
        }
      }
    }
    if (kind === 'achievement') {
      const activeSpec = this.root.submitBrainstormDecision.spec
      if (!activeSpec) return null
      return {
        component: 'achievement',
        props: {
          specTitle: this.root.handleAgentEvent.thread.title,
          specSummary: activeSpec.content.resolutionSummary,
          auditThread: this.durableAuditThread,
          auditState: this.root.submitSpecDecision.auditState,
          reportAvailable: this.auditReport !== null,
          achievementReached:
            this.root.handleAgentEvent.thread.status === 'completed' &&
            (this.root.handleAgentEvent.thread.loopIteration ?? 0) > 0,
          selectedThreadId: this.root.handleAgentEvent.thread.id,
          auditorSettings: this.auditSettings,
          providers: this.root.currentWorkingTraceAttribution.providers,
          projectId: this.root.handleAgentEvent.thread.projectId,
          favoriteModels: rendererRecovery.favoriteModels,
          recentModels: rendererRecovery.recentModels,
          onRemoveRecent: (key) => rendererRecovery.removeRecentModel(key),
          coordinatorWorking:
            this.root.switchProject.busy || this.root.buildSpecActionPrompt.delegatedWorkBusy,
          onOpenAudit: () => void this.root.buildSpecActionPrompt.generateAudit(this.auditSettings),
          onViewReport: this.openAuditStudio,
          onOpenThread: (auditor) => workspaceState.openThread(auditor, this.project),
          onResume: this.root.composerScope.resumeAchievementCoordination,
          onModelChange: this.changeAuditModel,
          onToggleFavorite: (providerId, modelId, harnessId) =>
            rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId)),
          onReorderFavorite: (draggedKey, targetKey, position) =>
            rendererRecovery.reorderFavorite(draggedKey, targetKey, position),
          onBackToCoordinator
        }
      }
    }
    if (this.root.currentWorkingTraceAttribution.independentAuditPanelActive) {
      return {
        component: 'independent-audit',
        props: {
          running: this.root.currentWorkingTraceAttribution.independentAuditRunning,
          auditThread: this.durableAuditThread,
          reportAvailable: this.auditReport !== null,
          partialReport: this.auditReport?.evidenceValidation === 'partial',
          selectedThreadId: this.root.handleAgentEvent.thread.id,
          auditorSettings: this.auditSettings,
          providers: this.root.currentWorkingTraceAttribution.providers,
          projectId: this.root.handleAgentEvent.thread.projectId,
          favoriteModels: rendererRecovery.favoriteModels,
          recentModels: rendererRecovery.recentModels,
          onRemoveRecent: (key) => rendererRecovery.removeRecentModel(key),
          onOpenAudit: () => void this.generateIndependentAudit(this.auditSettings),
          onViewReport: this.openAuditStudio,
          onNewAudit: () =>
            this.root.buildSpecActionPrompt.startFreshIndependentAudit(this.auditSettings),
          onDeleteThread: this.root.unmirroredTraceStartTime.deleteAuditorThread,
          onOpenThread: (auditor) => workspaceState.openThread(auditor, this.project),
          onModelChange: this.changeAuditModel,
          onToggleFavorite: (providerId, modelId, harnessId) =>
            rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId)),
          onReorderFavorite: (draggedKey, targetKey, position) =>
            rendererRecovery.reorderFavorite(draggedKey, targetKey, position),
          onBackToCoordinator
        }
      }
    }
    const auditSpec = this.root.submitBrainstormDecision.spec
    if (
      !auditSpec &&
      !this.root.submitBrainstormDecision.brainstormWorkflow?.finalizedBrainstormVersion
    )
      return null
    return {
      component: 'achievement',
      props: {
        mode: 'audit',
        specTitle: this.root.handleAgentEvent.thread.title,
        specSummary:
          auditSpec?.content.resolutionSummary ??
          this.root.editVideoNote.brainstorm?.content.summary ??
          '',
        auditThread: this.durableAuditThread,
        auditState: this.root.submitSpecDecision.auditState,
        reportAvailable: this.auditReport !== null,
        selectedThreadId: this.root.handleAgentEvent.thread.id,
        auditorSettings: this.auditSettings,
        providers: this.root.currentWorkingTraceAttribution.providers,
        projectId: this.root.handleAgentEvent.thread.projectId,
        favoriteModels: rendererRecovery.favoriteModels,
        recentModels: rendererRecovery.recentModels,
        onRemoveRecent: (key) => rendererRecovery.removeRecentModel(key),
        coordinatorWorking: this.root.submitSpecDecision.auditBusy,
        onOpenAudit: () => void this.root.buildSpecActionPrompt.generateAudit(this.auditSettings),
        onViewReport: this.openAuditStudio,
        onOpenThread: (auditor) => workspaceState.openThread(auditor, this.project),
        onModelChange: this.changeAuditModel,
        onToggleFavorite: (providerId, modelId, harnessId) =>
          rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId)),
        onReorderFavorite: (draggedKey, targetKey, position) =>
          rendererRecovery.reorderFavorite(draggedKey, targetKey, position),
        onBackToCoordinator
      }
    }
  }

  async activateBankedReset(): Promise<void> {
    const { projectId, id } = this.root.handleAgentEvent.thread
    const result = await invoke('agent:activateBankedReset', projectId, id)
    if (!result) return
    this.accountUsageCache.replaceUsage(
      this.accountUsageCache.usage.map((usage) =>
        usage.harnessId === result.harnessId && usage.providerId === result.providerId
          ? result
          : usage
      )
    )
    if (
      result.harnessId === this.root.loadOlderMessages.settings.harnessId &&
      result.providerId === this.root.loadOlderMessages.settings.providerId
    ) {
      this.commitContextUsage(
        mergeContextUsage(this.contextUsageDisplay, {
          ...(this.contextUsageDisplay ?? { costUsd: 0, rateLimits: [] }),
          rateLimits: result.rateLimits,
          credits: result.credits,
          bankedResets: result.bankedResets
        })
      )
    }
  }

  openAuditStudio(): void {
    this.root.harnessUsage.studioDocument = 'audit'
    this.root.submitSpecDecision.showSpecStudio = true
  }

  async generateDurableImplementationAudit(
    selected: ThreadSettings,
    coordinatorThreadId = this.root.handleAgentEvent.thread.id
  ): Promise<void> {
    this.root.submitSpecDecision.auditBusy = true
    this.root.buildSpecActionPrompt.auditError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.root.submitSpecDecision.auditState = 'running'
    this.auditSettings = selected
    rendererRecovery.addRecentModel(
      modelKey(selected.harnessId, selected.providerId, selected.modelId)
    )
    try {
      this.durableAuditThread = await invoke(
        'agent:ensureImplementationAuditorThread',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        selected
      )
      if (this.root.handleAgentEvent.thread.id === coordinatorThreadId) {
        coordinatorDockState.restore(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
        contextSidebarState.openCoordinator(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          'Audit coordinator'
        )
      }
      this.auditReport = await invoke(
        'agent:generateAudit',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        {
          settings: selected
        }
      )
      this.root.buildSpecActionPrompt.auditVersions = await invoke(
        'audit:listVersions',
        this.root.handleAgentEvent.thread.projectId,
        coordinatorThreadId,
        this.auditReport.id
      )
      this.root.submitSpecDecision.auditState = 'report_ready'
    } catch (error) {
      this.root.submitSpecDecision.auditState = 'offered'
      const rawError = error instanceof Error ? error.message : 'The implementation audit failed.'
      this.root.handleAgentEvent.errorMessage = rawError.replace(
        /^Error invoking remote method '[^']+': Error:\s*/u,
        ''
      )
      this.root.buildSpecActionPrompt.auditError = this.root.handleAgentEvent.errorMessage
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  /** Run an independent (spec-less) audit from the audit coordinator. The
   *  report joins the thread's existing report versions in Spec Studio.
   *  Clicking "Run audit" is the commit: the staged switch becomes durable
   *  here, which is what locks Engineering out for the thread's lifetime. */
  async generateIndependentAudit(selected: ThreadSettings): Promise<void> {
    this.root.submitSpecDecision.auditBusy = true
    this.root.buildSpecActionPrompt.auditError = ''
    this.root.handleAgentEvent.errorMessage = ''
    this.auditSettings = selected
    rendererRecovery.addRecentModel(
      modelKey(selected.harnessId, selected.providerId, selected.modelId)
    )
    try {
      if (!this.root.currentWorkingTraceAttribution.independentAuditEnabled) {
        await invoke(
          'thread:setIndependentAudit',
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id,
          true
        )
        this.root.currentWorkingTraceAttribution.pendingIndependentAudit = null
        clearIndependentAuditIntent(
          this.root.handleAgentEvent.thread.projectId,
          this.root.handleAgentEvent.thread.id
        )
      }
      this.durableAuditThread = await invoke(
        'agent:ensureIndependentAuditorThread',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        selected
      )
      coordinatorDockState.restore(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
      contextSidebarState.openCoordinator(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        'Audit coordinator'
      )
      const result = await invoke(
        'agent:generateIndependentAudit',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        {
          settings: selected
        }
      )
      this.auditReport = result.report
      this.durableAuditThread = result.auditorThread
      // The main process persists `report_ready`; mirror it locally so the
      // studio's Review / Complete actions light up without waiting for the
      // thread-update broadcast.
      this.root.submitSpecDecision.auditState = 'report_ready'
      this.root.buildSpecActionPrompt.auditVersions = await invoke(
        'audit:listVersions',
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id,
        this.auditReport.id
      )
    } catch (error) {
      const rawError = error instanceof Error ? error.message : 'The independent audit failed.'
      this.root.handleAgentEvent.errorMessage = rawError.replace(
        /^Error invoking remote method '[^']+': Error:\s*/u,
        ''
      )
      this.root.buildSpecActionPrompt.auditError = this.root.handleAgentEvent.errorMessage
    } finally {
      this.root.submitSpecDecision.auditBusy = false
    }
  }

  changeAuditModel(selected: ThreadSettings): void {
    const normalized = normalizeFastInference(
      selected,
      selected.harnessId,
      selected.providerId,
      selected.modelId,
      this.root.currentWorkingTraceAttribution.fastSupportedFor(
        selected.harnessId,
        selected.providerId,
        selected.modelId
      ),
      this.root.currentWorkingTraceAttribution.ultrafastSupportedFor(
        selected.harnessId,
        selected.providerId,
        selected.modelId
      )
    )
    this.auditSettings = normalized
    const auditor = {
      harnessId: normalized.harnessId,
      providerId: normalized.providerId,
      modelId: normalized.modelId,
      thinkingLevel: normalized.thinkingLevel,
      inferenceMode: normalized.inferenceMode,
      contextWindow: normalized.contextWindow
    }
    rendererRecovery.setAuditModel(
      modelKey(normalized.harnessId, normalized.providerId, normalized.modelId)
    )
    if (this.root.unmirroredTraceStartTime.isAssignmentAuditorThread) {
      this.updateSettings({
        ...this.root.loadOlderMessages.settings,
        ...normalized,
        permissionLevel: 'auto_review',
        assignmentMode: false,
        loopMode: false,
        loopAuditor: undefined
      })
      this.root.sources.syncAgentRole('auditor', auditor)
      return
    }
    this.updateSettings({ ...this.root.loadOlderMessages.settings, loopAuditor: auditor })
    this.root.sources.syncAgentRole('auditor', auditor)
  }

  updateSettings(updated: ThreadSettings): void {
    // Chats never change the permission level or the engineering workflow.
    const incoming = this.root.props.chatMode ? normalizeChatSettings(updated) : updated
    const seniorModelChanged =
      this.root.loadOlderMessages.settings.harnessId !== incoming.harnessId ||
      this.root.loadOlderMessages.settings.providerId !== incoming.providerId ||
      this.root.loadOlderMessages.settings.modelId !== incoming.modelId
    const loopJustEnabled =
      this.root.loadOlderMessages.settings.loopMode !== true && incoming.loopMode === true
    const loopAuditor =
      this.auditSettings.harnessId && this.auditSettings.providerId && this.auditSettings.modelId
        ? {
            harnessId: this.auditSettings.harnessId,
            providerId: this.auditSettings.providerId,
            modelId: this.auditSettings.modelId,
            thinkingLevel: this.auditSettings.thinkingLevel,
            inferenceMode: this.auditSettings.inferenceMode,
            contextWindow: this.auditSettings.contextWindow
          }
        : undefined
    // Fast inference only exists for models that actually support it. A model
    // switch must never carry a `fast` mode into a model (or harness) without
    // a fast tier   the resolved `*-fast` id would target a nonexistent model.
    const effectiveIncoming = seniorModelChanged
      ? normalizeFastInference(
          incoming,
          incoming.harnessId,
          incoming.providerId,
          incoming.modelId,
          incoming.inferenceMode === 'fast'
            ? this.root.currentWorkingTraceAttribution.fastSupportedFor(
                incoming.harnessId,
                incoming.providerId,
                incoming.modelId
              )
            : undefined
        )
      : incoming
    const normalized: ThreadSettings = {
      ...effectiveIncoming,
      ...(loopJustEnabled && loopAuditor ? { loopAuditor } : {})
    }
    const harnessChanged = this.root.loadOlderMessages.settings.harnessId !== normalized.harnessId
    const providerChanged =
      this.root.loadOlderMessages.settings.providerId !== normalized.providerId
    this.root.loadOlderMessages.settings = normalized
    if (this.root.props.controller) {
      this.root.sources.commitSettings(normalized)
      this.root.props.controller.updateSettings(normalized)
      // Side chats pick their harness in the composer before the first turn, so
      // the slash menu must follow the same switch logic threads have.
      if (harnessChanged) {
        void this.root.switchProject.refreshCommands()
        void this.root.studioTemporaryChatContext.refreshCapabilitySkills()
      }
      return
    }
    if (harnessChanged || providerChanged) {
      // Reset only the single-harness context meter so the battery reflects
      // the newly selected configuration. Preserve the live per-harness quota
      // overlay: quota already fetched for harnesses used in this conversation
      // stays visible and refreshes on the next hover. Force that hover to
      // refetch so the newly selected harness's quota is current.
      this.contextUsageDisplay = undefined
      this.accountUsageCache.markStale()
      // The provider card survives the switch. Picking another model or harness
      // is the user's fix for the failure, and Retry is the action that carries
      // it out: it re-sends the unanswered request through the current settings
      // on a fresh session, exactly as a "continue" message would. Dropping the
      // card here used to hide that button the instant the pick landed, forcing
      // the user to type the continuation by hand. The card keeps attributing
      // the issue to the harness that reported it (`statusCardProviderName`),
      // while its picker mirrors the newly selected configuration.
    }
    if (seniorModelChanged && this.root.submitBrainstormDecision.engineeringOn) {
      this.root.sources.syncAgentRole('seniorEngineer', {
        harnessId: normalized.harnessId,
        providerId: normalized.providerId,
        modelId: normalized.modelId,
        thinkingLevel: normalized.thinkingLevel,
        inferenceMode: normalized.inferenceMode,
        contextWindow: normalized.contextWindow
      })
    }
    // Persist immediately so the choice survives navigation away from this view.
    this.root.sources.commitSettings(normalized)
    const persistence = invoke(
      'thread:updateSettings',
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      normalized
    )
    if (harnessChanged) {
      void persistence
        .then(() => {
          this.root.switchProject.refreshCommands()
          this.root.studioTemporaryChatContext.refreshCapabilitySkills()
        })
        .catch(() => {
          this.root.switchProject.commands = []
          this.root.studioTemporaryChatContext.capabilitySkills = []
        })
    } else {
      persistence.catch(() => {
        // Non-fatal   the send path persists the settings again.
      })
    }
    if (loopJustEnabled && normalized.assignmentMode !== true) {
      void persistence
        .then(() =>
          invoke(
            'agent:ensureAchievementScope',
            this.root.handleAgentEvent.thread.projectId,
            this.root.handleAgentEvent.thread.id
          )
        )
        .then((updatedThread) => {
          scopeState.updateThread(updatedThread)
          return scopeState.ensureBoardLoaded(this.root.handleAgentEvent.thread.projectId)
        })
        .catch((error) => {
          this.root.handleAgentEvent.errorMessage =
            error instanceof Error ? error.message : 'The Achievement scope could not be created.'
        })
    }
  }
}
