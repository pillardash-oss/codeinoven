import { scopeState } from '$lib/stores/scope.svelte'
import { getProjectIcon } from '$lib/project-icons'
import { permissionLevelForAction } from '$lib/actions'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { invoke } from '$lib/ipc.svelte'

import { resolveDefaultThinkingLevel } from '$shared/thinking-presets'
import { saveLifecycleIntent } from '$lib/stores/lifecycle-intent'
import { withProjectOven } from '$lib/thread-settings-inheritance'
import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import {
  connectionsFromPlan,
  type AssistantPlanDraft
} from '$lib/components/assistant/assistant-view'
import {
  latestAssistantRecap,
  assistantSetupRecapIssue,
  assistantKnowledgeLoss,
  type AssistantKnowledgeLoss
} from '$lib/components/assistant/assistant-recap'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { agentRuns } from '$lib/stores/agent-runs.svelte'
import { toast } from 'svelte-sonner'
import { reportError } from '$lib/stores/app-errors.svelte'
import { appConfirm } from '$lib/stores/app-confirm.svelte'
import { DEFAULT_SCOPE_BUCKET_ID, assistantIsScheduled } from '$shared/types'
import type {
  Assistant,
  Thread,
  ThinkingLevel,
  ScopedHarnessCommand,
  EngineeringLifecycleSelectionInput,
  EngineeringLifecycleStage
} from '$shared/types'
import { normalizeLifecycleStages } from '$shared/engines/engineering-lifecycle-engine'
import { generationDetails, type GenerationObservation } from '$lib/generation-details'
import {
  harnessDisplayName,
  messageHarnessName,
  messageModelLabel,
  messageProvider,
  messageText,
  messageTokenRate
} from '../thread-message-presentation'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewSwitchProject extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  busy = $derived(
    this.root.props.controller?.busy ??
      agentRuns.isBusy(
        this.root.handleAgentEvent.thread.projectId,
        this.root.handleAgentEvent.thread.id
      )
  )

  finalizedGenerationObservation = $state<{
    messageId: string
    observation: GenerationObservation
  } | null>(null)

  lastCompletedGeneration = $derived.by(() => {
    if (this.busy) return null
    for (let index = this.root.loadOlderMessages.messages.length - 1; index >= 0; index -= 1) {
      const message = this.root.loadOlderMessages.messages[index]
      if (message.role !== 'assistant') continue
      const rate = messageTokenRate(message, {
        finalizedTokenRates: this.root.unmirroredTraceStartTime.finalizedTokenRates,
        liveTokenRate: this.root.handleAgentEvent.liveTokenRate
      })
      if (rate !== null) return { message, rate }
    }
    return null
  })

  /** The figure the shoe carries: the live reading when its window supports one,
   *  the last figure measured when it does not, and the settled message's own rate
   *  once the turn ends. A reading is only replaced by a newer one. */
  composerGenerationRate = $derived.by(() => {
    if (!this.busy) {
      const settled = this.lastCompletedGeneration?.rate
      if (settled != null) return settled
    }
    return this.root.handleAgentEvent.liveTokenRate.displayRate()
  })

  composerGenerationDetails = $derived.by(() => {
    const id = this.busy
      ? this.root.handleAgentEvent.liveTokenRate.messageId
      : this.lastCompletedGeneration?.message.id
    const message = this.busy
      ? this.root.loadOlderMessages.messages.findLast((entry) => entry.id === id)
      : this.lastCompletedGeneration?.message
    // The catalogs own the operator-facing names, so the panel can draw the
    // harness and the vendor the model ran through instead of printing ids.
    const provider = message
      ? messageProvider(message, this.root.currentWorkingTraceAttribution.providers)
      : undefined
    return generationDetails({
      message: {
        ...message,
        ...(this.root.studioTemporaryChatContext.streamedGenerationUsage?.messageId === id
          ? this.root.studioTemporaryChatContext.streamedGenerationUsage?.usage
          : {})
      },
      observation: this.busy
        ? this.root.handleAgentEvent.liveTokenRate.observation()
        : this.finalizedGenerationObservation?.messageId === id
          ? this.finalizedGenerationObservation?.observation
          : undefined,
      attribution: message
        ? {
            harnessName: messageHarnessName(
              message,
              this.root.unmirroredTraceStartTime.messageHarnessFallback
            ),
            providerName: provider?.name,
            modelLabel:
              messageModelLabel(message, this.root.currentWorkingTraceAttribution.allModels) ??
              undefined
          }
        : undefined
    })
  })

  /** Toolbox toggles are intent, never action: the selection is only staged here
   *  and applied when the user actually sends a message. Flipping switches while
   *  "playing around" in the composer must never apply settings, surface audit/
   *  assignment offer cards, or pop the replacement guard. */
  selectEngineeringLifecycle(input: EngineeringLifecycleSelectionInput): void {
    this.root.harnessUsage.pendingLifecycleSelection = input
    // Persist the staged intent so the switches stay exactly where the user
    // left them across thread switches and app restarts   a send must never
    // steer a different prompt than the one the switches currently show.
    saveLifecycleIntent(
      this.root.handleAgentEvent.thread.projectId,
      this.root.handleAgentEvent.thread.id,
      input
    )
  }

  commands = $state<ScopedHarnessCommand[]>([])

  projectIconUrl = $state<string | null>(null)

  compacting = $state(false)

  commandExecuting = $state(false)

  providerName = $derived(harnessDisplayName(this.root.loadOlderMessages.settings.harnessId))

  /** The lifecycle selection currently in force: a staged (intent-only)
   *  selection from the toolbox or action menu wins over the persisted one. */
  effectiveLifecycleSelection = $derived.by(
    (): { stages: EngineeringLifecycleStage[]; autopilot: boolean } => {
      const pending = this.root.harnessUsage.pendingLifecycleSelection
      if (pending) {
        return {
          stages: normalizeLifecycleStages(pending.stages),
          autopilot: pending.autopilot === true
        }
      }
      return {
        stages: normalizeLifecycleStages(
          this.root.handleAgentEvent.engineeringLifecycle?.selectedStages ?? []
        ),
        autopilot: this.root.handleAgentEvent.engineeringLifecycle?.autopilot === true
      }
    }
  )

  actionId(value: string): ActionDefinition['id'] {
    return value as ActionDefinition['id']
  }

  delegatedActivityLabel = $derived.by((): string => {
    const assignmentCoordinator =
      this.root.submitSpecDecision.assignment?.coordinatorThreadId ===
      this.root.handleAgentEvent.thread.id
    const workerCount = assignmentCoordinator
      ? this.root.buildSpecActionPrompt.activeAssignmentWorkerCount
      : 0
    const auditorWorking = assignmentCoordinator
      ? this.root.buildSpecActionPrompt.assignmentAuditorWorking
      : this.root.buildSpecActionPrompt.achievementAuditorWorking
    if (workerCount > 0 && auditorWorking) {
      return this.busy
        ? `Sr. Engineer, ${workerCount} ${workerCount === 1 ? 'worker' : 'workers'}, and the auditor are working`
        : `${workerCount} ${workerCount === 1 ? 'worker' : 'workers'} and the auditor are working`
    }
    if (workerCount > 0) {
      return this.busy
        ? `Sr. Engineer and ${workerCount} ${workerCount === 1 ? 'worker are' : 'workers are'} working`
        : `${workerCount} ${workerCount === 1 ? 'worker is' : 'workers are'} working`
    }
    return this.busy ? 'Sr. Engineer and the auditor are working' : 'The auditor is working'
  })

  /** Load project info for the composer context row. */
  async loadProjectContext(): Promise<void> {
    const { projectId } = this.root.handleAgentEvent.thread
    void scopeState.ensureBoardLoaded(projectId)
    try {
      this.root.contextUsage.project = await invoke('project:get', projectId)
      if (this.root.contextUsage.project?.icon) {
        this.projectIconUrl = await invoke('project:getIcon', projectId)
      }
    } catch {
      this.root.contextUsage.project = null
    }
  }

  /** True while a move is in flight. Choosing a second project before the first
   *  create settles would otherwise leave an orphan thread behind in the project
   *  the user skipped past. */
  switchingProject = false

  /**
   * Hand this not-yet-used thread to another project.
   *
   * A thread is owned by exactly one project, so handing it over is a create and
   * a delete, in that order: the destination project gets a thread that inherits
   * this one's provider, settings and title, the unsent draft moves across
   * object-to-object (never through the clipboard), and only once the new thread
   * owns the draft is the source thread deleted. The sidebar needs no special
   * handling   opening the new thread puts its row in the list, and the
   * `thread:deleted` broadcast removes the old row, exactly as they do for every
   * other thread.
   */
  async switchProject(targetProjectId: string): Promise<void> {
    if (this.switchingProject) return
    const oldProjectId = this.root.handleAgentEvent.thread.projectId
    const oldThreadId = this.root.handleAgentEvent.thread.id
    // Picking the project the thread already lives in is not a move: without this
    // guard it would churn the thread id for nothing.
    if (targetProjectId === oldProjectId) return

    const targetProject = scopeState.projectRecords.find((p) => p.id === targetProjectId)
    if (!targetProject) return

    const oldTitle = this.root.handleAgentEvent.thread.title
    const providerId = this.root.handleAgentEvent.thread.providerId
    // The destination project decides the machine: a thread moved into a local
    // project runs here, and one moved into a project bound to an Oven runs on
    // that Oven, exactly as a thread created there would.
    const settings = this.root.handleAgentEvent.thread.settings
      ? withProjectOven(this.root.handleAgentEvent.thread.settings, targetProject, false)
      : this.root.handleAgentEvent.thread.settings
    const draft = rendererRecovery.draftFor(oldProjectId, oldThreadId)
    const attachments = rendererRecovery.attachmentsFor(oldProjectId, oldThreadId)
    const references = rendererRecovery.projectReferencesFor(oldProjectId, oldThreadId)
    const taskReferences = rendererRecovery.taskReferencesFor(oldProjectId, oldThreadId)
    const promptReferences = rendererRecovery.draftPromptReferences(oldProjectId, oldThreadId)
    const hasDraftContent =
      draft.length > 0 ||
      attachments.length > 0 ||
      references.length > 0 ||
      taskReferences.length > 0 ||
      promptReferences.length > 0

    this.switchingProject = true
    try {
      let newThread: Thread
      try {
        newThread = await invoke('thread:create', {
          projectId: targetProjectId,
          providerId,
          title: oldTitle,
          workingDirectory: targetProject.path,
          settings,
          scopeBucketId: DEFAULT_SCOPE_BUCKET_ID
        })
      } catch (error) {
        // The source thread and its draft are untouched, so the composer still
        // holds whatever the user had typed and the move can simply be retried.
        reportError(error, 'The thread could not be moved.')
        return
      }

      if (hasDraftContent) {
        rendererRecovery.setDraft(
          targetProjectId,
          newThread.id,
          draft,
          attachments,
          references,
          taskReferences,
          promptReferences
        )
      }
      // Only now that the new thread owns the draft is the source cleared.
      // Clearing it up front would silently destroy the user's unsent text
      // whenever the create failed.
      rendererRecovery.clearDraft(oldProjectId, oldThreadId)

      // Fire-and-forget: main owns the outcome and toasts either way   it restores
      // the row when the delete failed, and broadcasts `thread:deleted` when the row
      // is gone, so this side never has to guess which state the thread is in.
      invoke('thread:delete', oldProjectId, oldThreadId).catch(() => {})
      scopeState.removeThread(oldThreadId)
      workspaceState.openThread(newThread, targetProject)
      scopeState.updateThread(newThread)
      scopeState.activeProjectId = targetProjectId
      void scopeState.ensureBoardLoaded(targetProjectId)
      invoke('project:getIcon', targetProjectId)
        .then((url) => {
          this.projectIconUrl = url
        })
        .catch(() => {})
    } finally {
      this.switchingProject = false
    }
  }

  async refreshCommands(): Promise<void> {
    const scope = this.root.studioTemporaryChatContext.capabilityScope()
    try {
      const discovered = await invoke(
        'agent:listCommands',
        scope.projectId,
        scope.threadId,
        scope.harnessId
      )
      // A side chat is read-only and owns no thread row, so its harness session
      // commands (config, settings, usage-credits) cannot run there. Only its
      // skills stay on the menu; they ride the read-only prompt path below.
      this.commands = this.root.loadOlderMessages.hasController
        ? discovered.filter((command) => command.source === 'skill')
        : discovered
    } catch {
      // Command discovery is supplementary; messaging remains available.
      this.commands = []
    }
  }

  async compactWork(): Promise<void> {
    if (this.compacting || this.busy) return
    const { projectId, id } = this.root.handleAgentEvent.thread
    this.compacting = true
    this.root.handleAgentEvent.errorMessage = ''
    try {
      await invoke('agent:compact', projectId, id)
      await this.root.abortRun.refreshMessages()
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The work could not be compacted.'
    } finally {
      this.compacting = false
    }
  }

  assistantBehaviorSession = $derived(this.root.loadOlderMessages.settings.assistantBehaviorSession)

  assistantSessionReady = $derived(
    !this.busy &&
      this.assistantBehaviorSession !== undefined &&
      (this.assistantBehaviorSession.saved === true ||
        (this.root.loadOlderMessages.messages.at(-1)?.role === 'assistant' &&
          (this.root.loadOlderMessages.messages.at(-1)?.createdAt ?? 0) >
            this.assistantBehaviorSession.startedAt &&
          this.root.loadOlderMessages.messages.at(-1)?.completedAt !== undefined))
  )

  dismissAssistantSessionQuestion(): void {
    if (!this.assistantBehaviorSession || this.assistantBehaviorSession.dismissals > 0) {
      this.root.unmirroredTraceStartTime.finishAssistantBehaviorSession()
      return
    }
    this.root.contextUsage.updateSettings({
      ...this.root.loadOlderMessages.settings,
      assistantBehaviorSession: { ...this.assistantBehaviorSession, dismissals: 1 }
    })
  }

  /**
   * The complete draft the agent has presented for this assistant: the knowledge it
   * wrote plus the machine-readable plan (schedule and connections). A draft is
   * what makes the assistant committable, so the recap card and the fallback
   * command both key off it. It is computed only while the agent is idle: a
   * running turn streams the draft token by token, and re-parsing fences on
   * every delta would be wasted work for a card that cannot show yet anyway.
   * The authoring conversation is short and lives only until the assistant is
   * saved, so scanning it once per settled turn is bounded work.
   *
   * A saved assistant keeps its draft path on its Getting started thread alone, and
   * only for a revision that actually changes it: a message there tweaks the
   * knowledge, so a revised draft has to be committable, while a task or run thread
   * of the same assistant carries the saved knowledge and must never suggest a new one,
   * and the draft already committed must not read as a pending change.
   */
  assistantDraft = $derived.by(
    (): {
      knowledge: string
      plan: AssistantPlanDraft | null
    } | null => {
      if (!this.root.props.assistantMode || !this.root.props.assistantId || this.busy) return null
      const draft = latestAssistantRecap(this.root.loadOlderMessages.messages, messageText)
      if (!draft) return null
      const plan = draft.plan
      if (
        this.root.props.assistantKnowledgeComplete &&
        !this.root.abortRun.isAssistantRevision(draft, plan)
      )
        return null
      return { knowledge: draft.knowledge, plan }
    }
  )

  /**
   * Identity of the current draft. Dismissing the recap card hides it only for
   * this revision, so a revised draft brings the card back.
   */
  assistantDraftSignature = $derived(
    this.assistantDraft
      ? `${this.assistantDraft.knowledge.length}:${JSON.stringify(this.assistantDraft.plan)}`
      : ''
  )

  assistantSaving = $state(false)

  /** One replacement confirmation at a time, so a second Save cannot queue another. */
  assistantKnowledgeGate = $state(false)

  assistantRecapVisible = $derived(
    this.assistantDraft !== null &&
      !this.assistantSaving &&
      this.root.unmirroredTraceStartTime.assistantRecapDismissed !== this.assistantDraftSignature
  )

  /**
   * Whether the recap card takes the composer's place.
   *
   * A draft waiting for the user's sign-off is not something to type into, and the
   * card is asking for the one answer the composer would otherwise collect, so it
   * replaces the composer instead of stacking on its top edge. It stays there while
   * the save it started is in flight, so the composer never flashes in beneath the
   * finger that pressed Save.
   */
  assistantRecapInComposer = $derived(
    this.assistantDraft !== null && (this.assistantRecapVisible || this.assistantSaving)
  )

  assistantComposerCovered = $derived(
    this.root.abortRun.assistantSetupThread &&
      this.root.props.assistantKnowledgeComplete &&
      !this.busy &&
      !this.assistantDraft &&
      !this.assistantSaving &&
      this.root.handleAgentEvent.pendingQuestionRequests.length === 0 &&
      (this.assistantBehaviorSession === undefined || this.assistantSessionReady)
  )

  /**
   * The user's go-ahead for the pending assistant recap: commit the draft, then
   * have the agent post a short next-steps list in the Getting started thread.
   * Both the recap card's Save button and a typed confirmation route here, so
   * the follow-up turn happens whichever way the user agreed. The next-steps
   * turn belongs to an assistant's first save; an edit of an assistant that already
   * has its knowledge commits on its own, with nothing left to set up.
   */
  async confirmAssistantSave(): Promise<void> {
    if (!this.root.props.assistantId) return
    // The card is the answer to any confirmation question the agent asked beside
    // it, so that question is retired here rather than left pending: a session
    // sitting on an unanswered question cannot take the turn that follows the save.
    for (const request of this.root.handleAgentEvent.pendingQuestionRequests) {
      if (request.questions.some((question) => question.secretRequest === true)) continue
      await this.root.unmirroredTraceStartTime
        .handleQuestionDismiss(request.requestId)
        .catch(() => undefined)
    }
    const firstSave = !this.root.props.assistantKnowledgeComplete
    const saved = await this.saveAssistantKnowledge()
    if (saved && !firstSave && this.assistantBehaviorSession) {
      this.root.contextUsage.updateSettings({
        ...this.root.loadOlderMessages.settings,
        assistantBehaviorSession: { ...this.assistantBehaviorSession, saved: true }
      })
    }
    if (saved && firstSave)
      await assistants.postSetup(this.root.props.assistantId).catch(() => undefined)
  }

  /**
   * The gate on a revision that would delete most of the instructions it replaces.
   *
   * The agent presents the whole revised document, so a model that loses its place
   * writes a short block and calls it the replacement, and the recap card then
   * offers that block as an ordinary Save. The ask is a line, the thing at stake is
   * the instruction set the assistant follows on every run, and the two are only
   * comparable by reading the document end to end. A save that drops a quarter of
   * the saved knowledge therefore asks here first, with the lines it would delete in
   * front of the user.
   */
  async confirmKnowledgeReplacement(
    assistant: Assistant,
    loss: AssistantKnowledgeLoss
  ): Promise<boolean> {
    const shown = loss.removed.slice(0, 6)
    const remaining = loss.removed.length - shown.length
    return appConfirm.request({
      title: `Replace ${assistant.name}'s instructions?`,
      body: [
        `This revision keeps ${loss.nextLines} lines of the ${loss.previousLines} saved now, and removes ${loss.removed.length}.`,
        ...shown.map((line) => `Removed: ${line}`),
        remaining > 0
          ? `Another ${remaining} ${remaining === 1 ? 'saved line is' : 'saved lines are'} not carried over.`
          : ''
      ].filter((line) => line.length > 0),
      note: 'Saving replaces the instructions this assistant follows. A line removed here is gone from the next run onwards.',
      confirmLabel: 'Replace instructions',
      cancelLabel: 'Keep editing'
    })
  }

  /**
   * Commit the agent-drafted knowledge, schedule, and connections to the assistant
   * once the user agrees. Called by the recap card and by the `/save-knowledge`
   * fallback. Initial setup requires valid settings. A knowledge-only revision
   * preserves the saved schedule, connections and reporting agreement.
   */
  async saveAssistantKnowledge(draftOverride?: {
    knowledge: string
    plan: AssistantPlanDraft | null
  }): Promise<boolean> {
    if (!this.root.props.assistantId || this.assistantSaving) return false
    const draft = draftOverride ?? this.assistantDraft
    if (!draft) {
      this.root.handleAgentEvent.errorMessage = `No knowledge draft found in this thread yet. Ask the agent to present the final knowledge in a fenced knowledge block, then try again.`
      return false
    }
    // A revision is compared with what is saved, because the draft carries the
    // whole document and nothing else checks that it still contains one.
    const replacing =
      assistants.assistants.find((entry) => entry.id === this.root.props.assistantId) ?? null
    const loss = replacing ? assistantKnowledgeLoss(replacing.knowledge, draft.knowledge) : null
    if (replacing && loss) {
      if (this.assistantKnowledgeGate) return false
      this.assistantKnowledgeGate = true
      const approved = await this.confirmKnowledgeReplacement(replacing, loss).finally(() => {
        this.assistantKnowledgeGate = false
      })
      if (!approved) return false
    }
    const setupIssue = this.root.props.assistantKnowledgeComplete
      ? null
      : assistantSetupRecapIssue(this.root.abortRun.assistant, draft.plan)
    if (setupIssue) {
      await this.root.handleAgentEvent.sendMessage(
        `The application could not save this setup: ${setupIssue} Repair the recap using the decisions already agreed in this conversation and checkpoint. Do not ask those questions again. Include the complete knowledge block, opening with the Personality section, and an assistant block containing actual values for name, scheduled, schedule, scheduleName, connections, delivery and priority where applicable. Do not copy the JSON schema. Verify required connections or finish the setup steps you can perform before presenting the corrected recap for confirmation. Do not claim it is saved or ready.`,
        [],
        undefined,
        undefined,
        undefined,
        [],
        [],
        {
          action: 'Repair setup recap',
          body: 'Complete the settings already agreed before saving.'
        }
      )
      return false
    }
    this.assistantSaving = true
    try {
      const plan = draft.plan
      const assistant = replacing
      const wasScheduled = assistant ? assistantIsScheduled(assistant) : true
      const patch: Parameters<typeof assistants.updateAssistant>[1] = { knowledge: draft.knowledge }
      // A conversation settles who the assistant is as well as what it does, so a
      // plan that carries the name the user gave it, or a clock they did or did not
      // want, is applied on the same save. How it behaves is not here: it is the
      // `Personality` section of the knowledge the same save writes.
      if (plan?.name) patch.name = plan.name
      if (typeof plan?.scheduled === 'boolean') patch.scheduled = plan.scheduled
      const scheduled = plan?.scheduled ?? wasScheduled
      // An on-demand assistant has no schedule, so a plan that still carries one
      // (an agent that did not know) can never re-schedule it here.
      if (plan?.schedule && scheduled) patch.schedule = plan.schedule
      if (plan?.scheduleName && scheduled) patch.scheduleName = plan.scheduleName
      if (plan?.delivery) patch.delivery = plan.delivery
      if (plan?.priority) patch.priority = plan.priority
      if (plan && plan.connections.length > 0) {
        const catalog = await invoke('utilities:list').catch(() => null)
        patch.connections = connectionsFromPlan(
          plan.connections,
          assistant?.connections ?? [],
          catalog?.utilities ?? []
        )
      }
      await assistants.updateAssistant(this.root.props.assistantId, patch)
      // The name is the one part of the save the user should see confirmed, since
      // it is what the sidebar and every later message will call the assistant.
      toast.success(plan?.name ? `Saved as ${plan.name}` : 'Saved')
      this.root.unmirroredTraceStartTime.assistantRecapDismissed = ''
      return true
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : 'The assistant behavior could not be saved.'
      return false
    } finally {
      this.assistantSaving = false
    }
  }

  async executeHarnessCommand(commandId: string, args: string): Promise<void> {
    if (this.busy || this.commandExecuting) return
    if (commandId === 'command:save-knowledge') {
      await this.saveAssistantKnowledge()
      return
    }
    if (commandId === 'command:cio-utility') {
      this.root.unmirroredTraceStartTime.triggerCioUtilityTurn(args)
      return
    }
    if (commandId === 'command:cio-design') {
      this.root.unmirroredTraceStartTime.triggerCioDesignTurn(args)
      return
    }
    if (commandId === 'command:cio-video') {
      this.root.unmirroredTraceStartTime.triggerCioVideoTurn(args)
      return
    }
    if (commandId === 'command:cio-orchestrate') {
      this.root.unmirroredTraceStartTime.triggerCioOrchestrateTurn(args)
      return
    }
    if (commandId.startsWith('cio-skill:')) {
      this.root.studioTemporaryChatContext.triggerCapabilitySkill(commandId, args)
      return
    }
    const { projectId, id } = this.root.handleAgentEvent.thread
    const command = this.commands.find((candidate) => this.actionId(candidate.id) === commandId)
    if (!command) return
    if (this.root.loadOlderMessages.hasController) {
      // A side chat owns no thread row, so a harness-native command cannot run
      // against it (runCommand needs the thread's session). Its skills ride
      // the read-only prompt path instead; anything else is not offered there.
      if (command.source === 'skill')
        this.root.studioTemporaryChatContext.requestSkillUse(command.name, args)
      return
    }
    this.root.handleAgentEvent.errorMessage = ''
    this.root.handleAgentEvent.providerStatus = null
    this.commandExecuting = true
    try {
      await this.root.currentWorkingTraceAttribution.ensureSessionReady()
      await invoke('agent:runCommand', projectId, id, command.id, args)
      if (command.name === 'config' || command.name === 'settings') {
        toast.success(`${this.providerName} settings updated`)
      } else if (command.name === 'usage-credits') {
        toast.success('Requested API usage credits for this session')
      }
    } catch (error) {
      this.root.handleAgentEvent.errorMessage =
        error instanceof Error ? error.message : `/${command.name} could not be started.`
    } finally {
      this.commandExecuting = false
    }
  }

  async handleActionSelection(selection: ActionSelection): Promise<void> {
    const { action } = selection

    for (const provider of this.root.currentWorkingTraceAttribution.providers) {
      const model = provider.models.find(
        (candidate) =>
          this.actionId(`model:${provider.harnessId}:${provider.id}:${candidate.id}`) === action.id
      )
      if (model) {
        const thinkingLevel = resolveDefaultThinkingLevel(
          model.thinkingPresets,
          baseUrlProviderStore.defaultThinkingLevel(provider.harnessId, provider.id, model.id),
          this.root.loadOlderMessages.settings.thinkingLevel
        )
        this.root.contextUsage.updateSettings({
          ...this.root.loadOlderMessages.settings,
          harnessId: provider.harnessId,
          providerId: provider.id,
          modelId: model.id,
          ...(thinkingLevel ? { thinkingLevel } : {})
        })
        return
      }
    }

    const thinkingLevel = this.root.currentWorkingTraceAttribution.actionThinkingLevels.find(
      (level) => this.actionId(`reasoning:${level.id}`) === action.id
    )
    if (thinkingLevel) {
      this.root.contextUsage.updateSettings({
        ...this.root.loadOlderMessages.settings,
        thinkingLevel: thinkingLevel.id as ThinkingLevel
      })
      return
    }

    // Engineering lifecycle stage toggles stage their selection exactly like
    // the Engineering Toolbox: intent only, applied when a message is sent.
    const stageToggle = /^mode:stage:(brainstorm|prd|spec|assignment|achievement)$/u.exec(action.id)
    if (stageToggle) {
      const current = this.effectiveLifecycleSelection
      if (current.autopilot) return
      const stage = stageToggle[1] as EngineeringLifecycleStage
      const stages = current.stages.includes(stage)
        ? current.stages.filter((candidate) => candidate !== stage)
        : [...current.stages, stage]
      this.selectEngineeringLifecycle({ stages, autopilot: false })
      return
    }

    if (action.id === 'mode:autopilot') {
      const current = this.effectiveLifecycleSelection
      const autopilot = !current.autopilot
      this.selectEngineeringLifecycle({ stages: autopilot ? [] : current.stages, autopilot })
      return
    }

    const permissionLevel = permissionLevelForAction(action)
    if (permissionLevel) {
      this.root.contextUsage.updateSettings({
        ...this.root.loadOlderMessages.settings,
        permissionLevel
      })
      return
    }

    if (action.id === 'command:compact') {
      await this.compactWork()
      return
    }

    if (action.id === 'command:quick-chat') {
      this.root.sources.openQuickChatFromLastTurn()
      return
    }

    // The conversation's own browser runs the moment it is chosen, exactly like
    // quick chat: it takes no arguments, so there is never anything to type
    // after it, and it is a rail gesture rather than a harness command.
    if (action.id === 'command:browser') {
      this.root.editVideoNote.openThreadBrowser()
      return
    }

    // App-owned slash commands (/cio-utility, /cio-design, /cio-video and
    // capability skills) route through the same handler the composer's submit
    // path uses.
    if (
      action.id === 'command:cio-utility' ||
      action.id === 'command:cio-design' ||
      action.id === 'command:cio-video' ||
      action.id === 'command:cio-orchestrate' ||
      action.id.startsWith('cio-skill:')
    ) {
      await this.executeHarnessCommand(action.id, '')
      return
    }

    const command = this.commands.find((candidate) => this.actionId(candidate.id) === action.id)
    if (command) await this.executeHarnessCommand(command.id, '')
  }

  /** True when the thread has no conversation yet   the composer is centered
   *  with suggested prompts instead of docked at the bottom. Declared here,
   *  after every state it reads (project, busy, pending queues, allModels),
   *  so the TS7 checker sees no use-before-declaration. */
  /** Resolved icon for the centered head-start header   same pipeline as the
   *  project sidebar: stored image, SVG icon type, then initials fallback. */
  centeredProjectIconUrl = $derived(
    this.root.contextUsage.project && !this.root.props.chatMode
      ? getProjectIcon(this.root.contextUsage.project, this.projectIconUrl ?? undefined)
      : null
  )
}
