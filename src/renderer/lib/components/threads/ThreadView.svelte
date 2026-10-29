<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type { ComposerShoeData } from '../chats/ComposerShoe.svelte'
  // The pickers and annotators below are reached by a gesture and are imported
  // where they are rendered. The five dialogs that take an `open` prop instead
  // stay static on purpose: each stays mounted so its own enter and exit
  // transition plays, and mounting it only while open would drop the exit. They
  // are small; the conversation's weight is the surface itself.
  import StartAfterThreadPicker from '../chats/StartAfterThreadPicker.svelte'
  import SelectionActionMenu from '../shared/SelectionActionMenu.svelte'
  import AnnotationIndicator from '../shared/AnnotationIndicator.svelte'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import MediaPreview from '../chats/MediaPreview.svelte'
  import AttachmentPreview from '../chats/AttachmentPreview.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import ContinueInProjectModal from './ContinueInProjectModal.svelte'
  import TranscriptExportModal from './TranscriptExportModal.svelte'
  import CodexBankedResetConfirm from '../ui/CodexBankedResetConfirm.svelte'
  import EngineeringFlowCancelModal from './EngineeringFlowCancelModal.svelte'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { isVideoMime } from '$lib/mime'
  import type { ActionDefinition } from '$lib/actions'
  import { loadCachedPanelModule, PANEL_KEYS } from '$lib/lazy-panel'
  import { logRendererError } from '$lib/system/renderer-logger'
  import { invoke } from '$lib/ipc.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import { hasSelectedStage } from '$shared/engines/engineering-lifecycle-engine'
  import { supportsManualCompaction } from '$shared/thread-status-policy'
  import { ANNOTATION_BUBBLE_SIZE } from '$lib/selection-anchors'
  import { createThreadView } from './ThreadView/ThreadView-board.svelte'
  import type { Props } from './ThreadView/ThreadView-types'
  import ThreadViewConversation from './ThreadView/ThreadViewConversation.svelte'
  import ThreadViewComposer from './ThreadView/ThreadViewComposer.svelte'
  import { permissionLevelActions } from '$lib/actions'

  let {
    thread: threadProp,
    chatMode = false,
    assistantMode = false,
    assistantId = null,
    assistantName = null,
    assistantKnowledgeComplete = false,
    assistantForeignRunThreadId = null,
    onForked,
    assistantSpaceThreads,
    onOpenAssistantThread,
    projects = [],
    projectIcons = new SvelteMap<string, string>(),
    onContinueInProject,
    onProjectCreated,
    onContinueInThread,
    controller,
    headerSnippet,
    allowCenteredComposer = true,
    emptyStateHeading,
    promptSuggestions,
    composerPlaceholder,
    onOpenScopeView,
    active = true
  }: Props = $props()
  const board = createThreadView(() => ({
    thread: threadProp,
    chatMode,
    assistantMode,
    assistantId,
    assistantName,
    assistantKnowledgeComplete,
    assistantForeignRunThreadId,
    onForked,
    assistantSpaceThreads,
    onOpenAssistantThread,
    projects,
    projectIcons,
    onContinueInProject,
    onProjectCreated,
    onContinueInThread,
    controller,
    headerSnippet,
    allowCenteredComposer,
    emptyStateHeading,
    promptSuggestions,
    composerPlaceholder,
    onOpenScopeView,
    active
  }))
  board.effects.setActiveActions(() => activeActions)
  board.submitBrainstormDecision.setReconcileReadySpec(() => reconcileReadySpecNow())
  let composerShoe = $derived.by((): ComposerShoeData => {
    const isNewThread = board.loadOlderMessages.messages.length === 0 && !board.switchProject.busy
    const identity = board.contextUsage.composerIdentity(board.handleAgentEvent.thread, isNewThread)
    return {
      identity,
      scope: board.composerScope.composerScope(identity, isNewThread),
      isWorking: board.switchProject.busy,
      oven: ovenPicker,
      onOpenOven: () => void board.openOvenPicker.openOvenPicker(),
      // Only a worker has a coordinator to report to, so only a worker gets the
      // control. Reporting stays on unless this thread switched it off, which
      // keeps the worker in a private iteration loop the user drives.
      report:
        board.handleAgentEvent.thread.assignmentRole === 'worker'
          ? {
              enabled: board.loadOlderMessages.settings.reportToCoordinator !== false,
              onChange: (enabled: boolean) =>
                board.contextUsage.updateSettings({
                  ...board.loadOlderMessages.settings,
                  reportToCoordinator: enabled
                })
            }
          : undefined
    }
  })

  let activeActions = $derived.by((): ActionDefinition[] => {
    const actions: ActionDefinition[] = []
    const modelActions: ActionDefinition[] = []

    for (const provider of board.currentWorkingTraceAttribution.providers) {
      for (const model of provider.models) {
        const favorite = rendererRecovery.isFavorite(
          modelKey(provider.harnessId, provider.id, model.id)
        )
        modelActions.push({
          id: board.switchProject.actionId(
            `model:${provider.harnessId}:${provider.id}:${model.id}`
          ),
          title: `Use ${model.name}`,
          description: `${favorite ? 'Favorite · ' : ''}${provider.name} · ${model.id}`,
          category: 'model',
          source: {
            id: `${provider.harnessId}:${provider.id}`,
            label: provider.name,
            kind: 'harness'
          },
          keywords: [provider.harnessId, provider.id, model.id, model.name],
          ...(board.switchProject.busy
            ? { disabledReason: 'Wait for the active run to finish' }
            : {})
        })
      }
    }
    actions.push(
      ...modelActions.sort((left, right) => {
        const leftFavorite = left.description?.startsWith('Favorite · ') === true
        const rightFavorite = right.description?.startsWith('Favorite · ') === true
        return Number(rightFavorite) - Number(leftFavorite)
      })
    )

    for (const level of board.currentWorkingTraceAttribution.actionThinkingLevels) {
      actions.push({
        id: board.switchProject.actionId(`reasoning:${level.id}`),
        title: `Thinking: ${level.label}`,
        description:
          board.loadOlderMessages.settings.thinkingLevel === level.id
            ? 'Current thinking level'
            : `Use ${level.label} reasoning for future turns`,
        category: 'reasoning',
        source: board.state.applicationActionSource,
        keywords: ['effort', 'reasoning', level.id]
      })
    }

    // Orchestration child threads (workers, auditors) are driven by their
    // coordinator   they can never enable engineering mode themselves, so the
    // stage toggles and Auto Pilot are not offered to them.
    if (!board.props.chatMode && !board.currentWorkingTraceAttribution.orchestrationChild) {
      // Engineering is a set of lifecycle stages, not one switch: expose every
      // stage as its own toggle so "turn engineering on/off" is never ambiguous.
      // Each action stages the selection exactly like the Engineering Toolbox
      // intent only, applied when the next message is sent.
      const lifecycle = board.switchProject.effectiveLifecycleSelection
      for (const stage of board.engineeringStageActions.engineeringStageActions) {
        const enabled = lifecycle.autopilot || lifecycle.stages.includes(stage.stage)
        actions.push({
          id: board.switchProject.actionId(`mode:stage:${stage.stage}`),
          title: enabled ? `Turn off ${stage.label}` : `Turn on ${stage.label}`,
          description: stage.description,
          category: 'mode',
          source: board.state.applicationActionSource,
          keywords: stage.keywords
        })
      }
      actions.push({
        id: 'mode:autopilot',
        title: lifecycle.autopilot ? 'Turn off Auto Pilot' : 'Turn on Auto Pilot',
        description: 'Run every Engineering stage on full autonomy, reworking until complete.',
        category: 'mode',
        source: board.state.applicationActionSource,
        keywords: ['autopilot', 'auto', 'pilot', 'autonomy', 'engineering']
      })
    }

    // Chat mode only surfaces permission levels once File System is enabled:
    // chats run with auto permission review until the user opts into files.
    if (!board.props.chatMode || board.loadOlderMessages.settings.fileSystemMode === true) {
      actions.push(...permissionLevelActions(board.state.applicationActionSource))
    }

    actions.push({
      id: 'command:compact',
      title: 'Compact conversation',
      description: 'Summarize older work to free context',
      category: 'command',
      source: board.state.applicationActionSource,
      keywords: ['summarize', 'context', 'tokens'],
      ...(!supportsManualCompaction(
        board.loadOlderMessages.settings.harnessId,
        providerStore.providers
      )
        ? {
            disabledReason: `${board.switchProject.providerName} does not support manual compaction`
          }
        : board.switchProject.busy
          ? { disabledReason: 'Wait for the active run to finish' }
          : {})
    })

    // Quick chat is anchored at the last agent turn, so it only makes sense once
    // the agent has responded. It deliberately stays usable while the agent is
    // working   no busy/commandExecuting disabledReason.
    // Controller-driven views (quick chats) never offer it   a quick chat
    // cannot open another quick chat from its own last turn.
    if (
      !board.loadOlderMessages.hasController &&
      board.loadOlderMessages.messages.some((message) => message.role === 'assistant')
    ) {
      actions.push({
        id: 'command:quick-chat',
        title: '/quick chat',
        description: 'Open a read-only quick chat from the last agent turn',
        category: 'command',
        source: board.state.applicationActionSource,
        keywords: ['quick', 'chat', 'side', 'question', 'temporary', 'read-only']
      })
    }

    // The conversation's own browser: reveal the page it already has, or start
    // a blank tab the user can type an address into. Offered only where a
    // conversation owns a thread browser   a project thread, an inbox chat, an
    // assistant task   never in a controller-driven side surface (a quick chat,
    // the browser rail's own conversation), which is a panel beside the page it
    // is about rather than a workspace of its own.
    if (!board.loadOlderMessages.hasController) {
      actions.push({
        id: 'command:browser',
        title: '/browser',
        description: "Open this thread's browser, or start a new tab to begin browsing",
        category: 'command',
        source: board.state.applicationActionSource,
        keywords: ['browser', 'web', 'browse', 'tab', 'page', 'site', 'address', 'url']
      })
    }

    for (const command of board.switchProject.commands) {
      actions.push({
        id: board.switchProject.actionId(command.id),
        title: `/${command.name}`,
        description: command.description,
        category:
          command.source === 'skill' ? 'skill' : command.source === 'mcp' ? 'mcp' : 'command',
        source: board.unmirroredTraceStartTime.harnessActionSource,
        keywords: [command.name, command.source, board.loadOlderMessages.settings.harnessId],
        ...(board.switchProject.busy || board.switchProject.commandExecuting
          ? { disabledReason: 'Wait for the active run to finish' }
          : {})
      })
    }

    // CodeInOven utility turn   the slash spelling of the @cio-utility composer
    // tag. Selecting sends the tag (plus any typed arguments) through the normal
    // send path, so the main-process utility orchestration owns the contract.
    actions.push({
      id: 'command:cio-utility',
      title: '/cio-utility',
      description: 'Start a CodeInOven utility turn   install utilities or debug the app',
      category: 'command',
      source: board.state.applicationActionSource,
      keywords: ['cio', 'utility', 'utilities', 'setup', 'install', 'skill', 'mcp', 'debug'],
      slashCommand: true,
      ...(board.switchProject.busy || board.switchProject.commandExecuting
        ? { disabledReason: 'Wait for the active run to finish' }
        : {})
    })

    // CodeInOven design session   the slash spelling of the @cio-design composer
    // tag. The tag promotes the app-owned design capability to an active
    // capability for the turn, so the agent starts designing instead of first
    // looking for a tool that designs.
    actions.push({
      id: 'command:cio-design',
      title: '/cio-design',
      description: 'Start a design session: design an interface and watch it render in the browser',
      category: 'command',
      source: board.state.applicationActionSource,
      keywords: ['cio', 'design', 'designer', 'prototype', 'ui', 'landing', 'page', 'wireframe'],
      slashCommand: true,
      ...(board.switchProject.busy || board.switchProject.commandExecuting
        ? { disabledReason: 'Wait for the active run to finish' }
        : {})
    })

    // CodeInOven video session   the slash spelling of the @cio-video composer
    // tag. The tag promotes the app-owned video capability to an active
    // capability for the turn, so the agent starts editing instead of first
    // looking for a tool that makes video.
    actions.push({
      id: 'command:cio-video',
      title: '/cio-video',
      description: 'Start a video session: make a video and watch it render in the browser',
      category: 'command',
      source: board.state.applicationActionSource,
      keywords: ['cio', 'video', 'motion', 'edit', 'cut', 'reel', 'animation', 'composition'],
      slashCommand: true,
      ...(board.switchProject.busy || board.switchProject.commandExecuting
        ? { disabledReason: 'Wait for the active run to finish' }
        : {})
    })

    // CodeInOven workstation control session   the slash spelling of the
    // @cio-hey composer tag. Selecting sends the tag (plus any typed
    // arguments) through the normal send path, so the main-process
    // orchestration contract owns the tooling that goes with it.
    actions.push({
      id: 'command:cio-orchestrate',
      title: '/cio-hey',
      description:
        'Start a workstation control turn: run work on a machine, model and account, or drive the app itself',
      category: 'command',
      source: board.state.applicationActionSource,
      keywords: [
        'hey',
        'cio',
        'orchestrate',
        'workstation',
        'oven',
        'machine',
        'model',
        'app',
        'panel',
        'rail'
      ],
      slashCommand: true,
      ...(board.switchProject.busy || board.switchProject.commandExecuting
        ? { disabledReason: 'Wait for the active run to finish' }
        : {})
    })

    // Assistant authoring: the agent drafts the assistant knowledge in conversation
    // and asks the user to confirm the recap. The recap card commits the agreed
    // draft in one click; this command is only the fallback for when that path
    // cannot run, so it appears only while a draft is waiting to be committed
    // and disappears for good once the assistant is saved.
    if (board.switchProject.assistantDraft) {
      actions.push({
        id: 'command:save-knowledge',
        title: '/save-knowledge',
        description: 'Fallback: save the behavior the agent drafted for this assistant',
        category: 'command',
        source: board.state.applicationActionSource,
        keywords: [
          'knowledge',
          'knowledge',
          'save',
          'assistant',
          'commit',
          'assistant',
          'fallback'
        ],
        slashCommand: true,
        ...(board.switchProject.busy || board.switchProject.commandExecuting
          ? { disabledReason: 'Wait for the active run to finish' }
          : {})
      })
    }

    // Skills the thread's harness can see but does not expose as native slash
    // commands: global-layer skills and CodeInOven-registered skills. Harness-
    // reported skills are skipped   they are already listed above.
    const harnessCommandNames = new Set(
      board.switchProject.commands.map((command) => command.name.toLocaleLowerCase())
    )
    for (const skill of board.studioTemporaryChatContext.capabilitySkills) {
      if (harnessCommandNames.has(skill.name.toLocaleLowerCase())) continue
      actions.push({
        id: board.switchProject.actionId(`cio-skill:${skill.id}`),
        title: `/${skill.name}`,
        description:
          skill.origin === 'global'
            ? `Global skill · ${skill.description ?? 'Available in every project'}`
            : skill.origin === 'application'
              ? `CodeInOven skill · ${skill.description ?? 'Installed via Utilities'}`
              : `${board.studioTemporaryChatContext.capabilityHarnessName || 'Harness'} skill · ${skill.description ?? ''}`.trim(),
        category: 'skill',
        source:
          skill.origin === 'harness'
            ? board.unmirroredTraceStartTime.harnessActionSource
            : skill.origin === 'global'
              ? board.state.globalSkillActionSource
              : board.state.applicationActionSource,
        keywords: [skill.name, skill.origin, 'skill'],
        slashCommand: true,
        ...(!skill.enabled
          ? { disabledReason: 'Disabled in Utilities' }
          : board.switchProject.busy || board.switchProject.commandExecuting
            ? { disabledReason: 'Wait for the active run to finish' }
            : {})
      })
    }

    return actions
  })

  /** The compaction notice owns no card component, so its fold preference is read
   *  and written here, per thread, like every other stack card. */
  const compactionFold = {
    get folded(): boolean {
      return threadCardFold.isFolded(board.handleAgentEvent.thread.id, 'compaction')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(board.handleAgentEvent.thread.id, 'compaction', value)
    }
  }

  async function reconcileReadySpecNow(): Promise<void> {
    const { projectId, id } = board.handleAgentEvent.thread
    const workflowThreadId = board.unmirroredTraceStartTime.isAssignmentAuditorThread
      ? (board.handleAgentEvent.thread.coordinatorThreadId ?? id)
      : id
    // A worker never owns the Assignment: it implements one task of its
    // coordinator's plan, and the main process keys every Assignment read on
    // that coordinator. Resolve it there so the child can present the parent's
    // board instead of an empty one.
    const assignmentThreadId =
      board.handleAgentEvent.thread.assignmentRole === 'worker'
        ? (board.handleAgentEvent.thread.coordinatorThreadId ?? workflowThreadId)
        : workflowThreadId
    const [
      active,
      workflowThread,
      activeAssignment,
      projectThreads,
      workflow,
      activeBrainstorm,
      activePrd
    ] = await Promise.all([
      invoke('spec:getActive', projectId, workflowThreadId),
      invoke('thread:get', projectId, workflowThreadId),
      invoke('assignment:getActive', projectId, assignmentThreadId),
      invoke('thread:list', projectId),
      invoke('brainstorm:getWorkflow', projectId, workflowThreadId),
      invoke('brainstorm:getActive', projectId, workflowThreadId),
      invoke('prd:getActive', projectId, workflowThreadId)
    ])
    if (!board.loadOlderMessages.alive) return
    board.currentWorkingTraceAttribution.coordinatorParentThread = board
      .currentWorkingTraceAttribution.coordinatorParentId
      ? (projectThreads.find(
          (candidate) => candidate.id === board.currentWorkingTraceAttribution.coordinatorParentId
        ) ??
        (await invoke(
          'thread:get',
          projectId,
          board.currentWorkingTraceAttribution.coordinatorParentId
        )))
      : null
    if (!board.loadOlderMessages.alive) return
    const staleSpecGeneration =
      active !== null &&
      board.handleAgentEvent.providerStatus?.state === 'working' &&
      board.handleAgentEvent.providerStatus.activity?.kind === 'spec_generation'
    if (staleSpecGeneration) {
      board.sources.clearSpecGenerationTrace()
      board.abortRun.clearLocalTurn()
      agentRuns.setIdle(board.handleAgentEvent.thread.projectId, board.handleAgentEvent.thread.id)
      if (board.handleAgentEvent.providerStatus?.state !== 'error')
        board.handleAgentEvent.providerStatus = null
    }
    if (board.submitSpecDecision.assignment) board.sources.clearAssignmentGenerationTrace()
    board.submitBrainstormDecision.brainstormWorkflow = workflow
    board.editVideoNote.brainstorm = activeBrainstorm
    board.harnessUsage.prd = activePrd
    board.harnessUsage.prdVersions = activePrd
      ? await invoke('prd:listVersions', projectId, workflowThreadId, activePrd.id)
      : []
    if (
      activePrd &&
      !board.harnessUsage.prdVersions.some(
        (candidate) => candidate.version === board.harnessUsage.selectedPrdVersion
      )
    ) {
      board.harnessUsage.selectedPrdVersion = activePrd.version
    }
    board.submitBrainstormDecision.brainstormGenerationFailed =
      workflowThread?.status === 'failed' &&
      workflow?.entryChoice !== undefined &&
      !activeBrainstorm &&
      !active
    board.editVideoNote.brainstormVersions = activeBrainstorm
      ? await invoke('brainstorm:listVersions', projectId, workflowThreadId, activeBrainstorm.id)
      : []
    if (
      activeBrainstorm &&
      !board.editVideoNote.brainstormVersions.some(
        (candidate) => candidate.version === board.editVideoNote.selectedBrainstormVersion
      )
    ) {
      board.editVideoNote.selectedBrainstormVersion = activeBrainstorm.version
    }
    board.submitSpecDecision.assignment = activeAssignment
    if (
      board.handleAgentEvent.engineeringLifecycle?.autopilot &&
      board.handleAgentEvent.engineeringLifecycle.activeStage === 'achievement' &&
      activeAssignment?.auditCycle?.status === 'completed'
    ) {
      board.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:complete',
        projectId,
        workflowThreadId,
        'achievement'
      )
      board.contextUsage.updateSettings(
        board.harnessUsage.settingsForEngineeringState(board.handleAgentEvent.engineeringLifecycle)
      )
    }
    if (
      hasSelectedStage(board.handleAgentEvent.engineeringLifecycle, 'assignment') &&
      board.handleAgentEvent.engineeringLifecycle?.activeStage === 'assignment' &&
      activeAssignment?.status === 'completed'
    ) {
      board.handleAgentEvent.engineeringLifecycle = await invoke(
        'engineeringLifecycle:complete',
        projectId,
        workflowThreadId,
        'assignment'
      )
      board.contextUsage.updateSettings(
        board.harnessUsage.settingsForEngineeringState(board.handleAgentEvent.engineeringLifecycle)
      )
    }
    board.submitSpecDecision.assignmentVersions = activeAssignment
      ? await invoke('assignment:listVersions', projectId, assignmentThreadId, activeAssignment.id)
      : []
    board.currentWorkingTraceAttribution.assignmentCoordinatorThread = projectThreads.find(
      (candidate) => candidate.id === activeAssignment?.coordinatorThreadId
    )
    board.buildSpecActionPrompt.assignmentAuditThread = activeAssignment?.auditorThreadId
      ? projectThreads.find((candidate) => candidate.id === activeAssignment.auditorThreadId)
      : undefined
    board.contextUsage.durableAuditThread = workflowThread?.auditorThreadId
      ? projectThreads.find((candidate) => candidate.id === workflowThread.auditorThreadId)
      : undefined
    board.currentWorkingTraceAttribution.assignmentThreads = activeAssignment
      ? projectThreads
          .filter(
            (candidate) =>
              candidate.assignmentId === activeAssignment.id &&
              candidate.assignmentRole === 'worker' &&
              activeAssignment.content.tasks.some((task) => task.threadId === candidate.id)
          )
          .sort((left, right) => {
            const taskThreadIds = activeAssignment.content.tasks.map((task) => task.threadId)
            return taskThreadIds.indexOf(left.id) - taskThreadIds.indexOf(right.id)
          })
      : []
    if (active) {
      await board.harnessUsage.setActiveSpec(active)
      const dismissed =
        workflowThread?.dismissedSpecId === active.id &&
        workflowThread.dismissedSpecVersion === active.version
      board.studioTemporaryChatContext.specReadyToolVisible =
        !board.unmirroredTraceStartTime.isAssignmentAuditorThread &&
        active.status !== 'approved' &&
        !dismissed
    } else {
      board.submitBrainstormDecision.spec = null
      board.unmirroredTraceStartTime.specVersions = []
      board.studioTemporaryChatContext.specReadyToolVisible = false
    }
    // The Spec/Assignment state above is now authoritative for this mount, so the
    // composer may show its ready card without a stale flash.
    board.composerScope.workflowReady = true
    board.submitSpecDecision.auditState = workflowThread?.auditState
    const activeAudit = await invoke('audit:getActive', projectId, workflowThreadId)
    if (!board.loadOlderMessages.alive) return
    if (activeAudit) {
      board.contextUsage.auditReport = activeAudit
      board.buildSpecActionPrompt.auditVersions = await invoke(
        'audit:listVersions',
        projectId,
        workflowThreadId,
        activeAudit.id
      )
    }
    if (!board.unmirroredTraceStartTime.isAssignmentAuditorThread) {
      const studioRequest = workspaceState.consumeThreadStudioOpen(projectId, id)
      if (studioRequest) {
        board.harnessUsage.studioDocument = studioRequest.document
        if (
          studioRequest.document === 'audit' &&
          studioRequest.auditReportId &&
          studioRequest.auditReportVersion !== undefined
        ) {
          const requestedReport = board.buildSpecActionPrompt.auditVersions.find(
            (candidate) =>
              candidate.id === studioRequest.auditReportId &&
              candidate.version === studioRequest.auditReportVersion
          )
          if (requestedReport) board.contextUsage.auditReport = requestedReport
        }
        board.submitSpecDecision.showSpecStudio = true
      }
    }
    if (
      !active &&
      workflowThread?.status !== 'failed' &&
      !board.state.planningResumeRequested &&
      (!board.handleAgentEvent.engineeringLifecycle ||
        (board.handleAgentEvent.engineeringLifecycle.selectedStages.length === 0 &&
          !board.handleAgentEvent.engineeringLifecycle.autopilot))
    ) {
      const resume =
        workflow?.stage === 'skipped'
          ? invoke('agent:chooseBrainstormEntry', projectId, workflowThreadId, 'spec')
          : workflow?.stage === 'finalized' && activeBrainstorm
            ? invoke(
                'agent:finalizeBrainstorm',
                projectId,
                workflowThreadId,
                activeBrainstorm.id,
                activeBrainstorm.version,
                ''
              )
            : null
      if (resume) {
        board.state.planningResumeRequested = true
        void resume
          .then(() => board.submitBrainstormDecision.reconcileReadySpec())
          .catch((error) => {
            board.harnessUsage.brainstormError =
              error instanceof Error ? error.message : 'Specification generation could not resume.'
          })
          .finally(() => {
            board.state.planningResumeRequested = false
          })
      }
    }
  }
</script>

{#snippet studioModuleLoading(label: string)}
  <div
    class="flex flex-1 items-center justify-center gap-2 text-xs text-dimmed"
    role="status"
    aria-label={`Loading ${label}`}
  >
    <CioSpinner size={14} class="animate-spin" />
    Loading {label}
  </div>
{/snippet}

{#snippet studioModuleFailed(key: string, label: string, error: unknown)}
  {logRendererError(`The ${label} studio could not be loaded`, error)}
  <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
    <p class="text-xs font-medium text-foreground">{label} could not load</p>
    <p class="max-w-[34ch] text-[0.625rem] leading-relaxed text-muted">
      Loading it was interrupted. Try again.
    </p>
    <button
      type="button"
      class="mt-1 bg-primary px-2 py-1 text-[0.625rem] text-on-primary transition-colors hover:bg-primary-hover"
      title={`Try loading the ${label} studio again`}
      aria-label={`Try loading the ${label} studio again`}
      onclick={() => board.studioReloadNonce.retryStudio(key)}
    >
      Retry
    </button>
  </div>
{/snippet}

{#snippet ovenPicker()}
  {#await import('./OvenControls.svelte') then { default: OvenControlsComponent }}
    <OvenControlsComponent
      bind:this={board.openOvenPicker.ovenControl}
      thread={board.handleAgentEvent.thread}
      settings={board.loadOlderMessages.settings}
      busy={board.switchProject.busy}
      variant="segment"
      onSettingsChange={board.contextUsage.updateSettings}
    />
  {:catch}
    <span class="text-xs text-danger" role="alert"
      >Oven controls could not be board.sources.loaded.</span
    >
  {/await}
{/snippet}

<!-- The annotatable surface the lightbox draws in place of the plain media
     element: an artifact picture or video with its marks, its pen and its
     numbered badges. The conversation itself shows the artifact plain, because
     the pen and the badges are decisions about the picture and belong where the
     picture is big enough to make them. -->
{#snippet viewerAnnotationSurface()}
  {@const item = board.studioTemporaryChatContext.viewerAnnotatableItem}
  {#if item}
    {#if isVideoMime(item.mime)}
      {#await import('./ArtifactVideoAnnotator.svelte') then { default: ArtifactVideoAnnotator }}
        <ArtifactVideoAnnotator
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
          url={item.url}
          src={board.state.imageUrls.getUrl(item.url)}
          filename={item.filename}
          startAt={board.studioTemporaryChatContext.messageViewer?.startAt}
          autoPlay={board.studioTemporaryChatContext.messageViewer?.playing ?? false}
          messageId={board.studioTemporaryChatContext.messageViewer?.messageId}
          marks={board.composerScope.marksFor(item.url)}
          editingId={board.unmirroredTraceStartTime.imageMarkEditorId}
          onEditClosed={board.unmirroredTraceStartTime.clearImageMarkEditor}
          onLoadError={(element) =>
            void board.state.imageUrls.bindMedia(item.url, item.mime, element)}
        />
      {/await}
    {:else}
      {#await import('./ArtifactImageAnnotator.svelte') then { default: ArtifactImageAnnotator }}
        <ArtifactImageAnnotator
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
          url={item.url}
          src={board.state.imageUrls.getUrl(item.url)}
          filename={item.filename}
          messageId={board.studioTemporaryChatContext.messageViewer?.messageId}
          marks={board.composerScope.marksFor(item.url)}
          editingId={board.unmirroredTraceStartTime.imageMarkEditorId}
          onEditClosed={board.unmirroredTraceStartTime.clearImageMarkEditor}
        />
      {/await}
    {/if}
  {/if}
{/snippet}

{#if board.studioTemporaryChatContext.messageViewer}
  {@const viewerItem =
    board.studioTemporaryChatContext.messageViewer.items[
      board.studioTemporaryChatContext.messageViewer.index
    ]}
  {@const viewerArtifact = viewerItem
    ? board.unmirroredTraceStartTime.viewerArtifactPath(viewerItem.url)
    : null}
  {#if viewerItem.media}
    <MediaPreview
      src={board.state.imageUrls.getUrl(viewerItem.url)}
      revealUrl={viewerItem.url}
      startAt={board.studioTemporaryChatContext.messageViewer.startAt}
      autoPlay={board.studioTemporaryChatContext.messageViewer.playing ?? false}
      filename={viewerItem.filename}
      mime={viewerItem.mime}
      pager={board.studioTemporaryChatContext.messageViewerPager}
      annotate={board.studioTemporaryChatContext.viewerAnnotatableItem
        ? viewerAnnotationSurface
        : undefined}
      onClose={board.studioTemporaryChatContext.closeMessageViewer}
      onReveal={viewerArtifact
        ? () => board.unmirroredTraceStartTime.revealViewerArtifact(viewerArtifact)
        : undefined}
      onLoadError={(el) => {
        const viewer = board.studioTemporaryChatContext.messageViewer
        const target = viewer?.items[viewer.index]
        if (target) void board.state.imageUrls.bindMedia(target.url, target.mime, el)
      }}
    />
  {:else}
    <AttachmentPreview
      attachment={viewerItem}
      src={board.studioTemporaryChatContext.attachmentPreview.urls[viewerItem.url]}
      text={board.studioTemporaryChatContext.attachmentPreview.texts[viewerItem.url]}
      documentHtml={board.studioTemporaryChatContext.attachmentPreview.documents[viewerItem.url]}
      documentLoading={board.studioTemporaryChatContext.attachmentPreview.documentLoading[
        viewerItem.url
      ] ?? false}
      pager={board.studioTemporaryChatContext.messageViewerPager}
      onClose={board.studioTemporaryChatContext.closeMessageViewer}
      onReveal={viewerArtifact
        ? () => board.unmirroredTraceStartTime.revealViewerArtifact(viewerArtifact)
        : undefined}
    />
  {/if}
{/if}

{#if board.studioTemporaryChatContext.queuedAttachmentViewer}
  {@const queuedViewerItem =
    board.studioTemporaryChatContext.queuedAttachmentViewer.items[
      board.studioTemporaryChatContext.queuedAttachmentViewer.index
    ]}
  {#if queuedViewerItem}
    <AttachmentPreview
      attachment={queuedViewerItem}
      src={board.studioTemporaryChatContext.attachmentPreview.urls[queuedViewerItem.url]}
      text={board.studioTemporaryChatContext.attachmentPreview.texts[queuedViewerItem.url]}
      documentHtml={board.studioTemporaryChatContext.attachmentPreview.documents[
        queuedViewerItem.url
      ]}
      documentLoading={board.studioTemporaryChatContext.attachmentPreview.documentLoading[
        queuedViewerItem.url
      ] ?? false}
      pager={board.studioTemporaryChatContext.queuedAttachmentPager}
      onClose={board.studioTemporaryChatContext.closeQueuedAttachmentViewer}
    />
  {/if}
{/if}

{#if board.sources.responseSelection}
  <SelectionActionMenu
    text={board.sources.responseSelection.text}
    anchor={board.sources.responseSelection.anchor}
    annotated={Boolean(board.sources.responseSelection.referenceId)}
    onComment={board.sources.commentOnResponseSelection}
    onElaborate={board.loadOlderMessages.hasController
      ? undefined
      : () => board.sources.openTemporarySelectionChat('elaborate')}
    onQuickChat={board.loadOlderMessages.hasController
      ? undefined
      : () => board.sources.openTemporarySelectionChat('quick')}
    onNewThread={board.sources.openSelectionInNewThread}
    onClose={board.sources.closeResponseSelection}
  />
{/if}

<!-- Comment bubbles pinned to attached response selections -->
{#each board.steerQueuedMessage.annotationReferences as reference, referenceIndex (reference.id)}
  {@const position = board.steerQueuedMessage.responseBubblePositions[reference.id]}
  {#if position?.visible}
    <AnnotationIndicator
      id={reference.id}
      surface="conversation"
      left={`${position.x}px`}
      top={`${position.y}px`}
      fixed
      number={referenceIndex + 1}
      hasComment={Boolean(reference.comment)}
      active={board.steerQueuedMessage.commentEditorReferenceId === reference.id}
      title={reference.comment
        ? `Edit comment on "${reference.label}". Drag to move it, click to edit.`
        : `Comment on "${reference.label}". Drag to move it, click to write.`}
      class="z-40"
      onOpen={() => (board.steerQueuedMessage.commentEditorReferenceId = reference.id)}
    />
  {/if}
{/each}

{#if board.steerQueuedMessage.commentEditorReferenceId}
  {@const editorReference = board.steerQueuedMessage.commentEditorReference()}
  {@const editorPosition = board.studioTemporaryChatContext.commentEditorAnchor}
  {#if editorReference && editorPosition}
    <ResponseAnnotationComment
      x={editorPosition.x + ANNOTATION_BUBBLE_SIZE / 2}
      y={editorPosition.y}
      initialComment={editorReference.comment ?? ''}
      targetId={`response-comment-${board.handleAgentEvent.thread.id}-${editorReference.id}`}
      scope={{ kind: 'project', projectId: board.handleAgentEvent.thread.projectId }}
      onDraftChange={(comment) =>
        board.unmirroredTraceStartTime.persistResponseReferenceCommentDraft(
          editorReference.id,
          comment
        )}
      onDone={(comment) =>
        board.composerScope.saveResponseReferenceComment(editorReference.id, comment)}
      onRemove={() => board.steerQueuedMessage.removeResponseReference(editorReference.id)}
      onClose={() => (board.steerQueuedMessage.commentEditorReferenceId = null)}
    />
  {/if}
{/if}

<div
  bind:this={board.state.threadViewElement}
  class="thread-view relative flex min-h-0 min-w-0 flex-1 flex-col"
  data-region={board.submitSpecDecision.showSpecStudio ? 'spec-studio' : undefined}
  data-drop-region={board.submitSpecDecision.showSpecStudio ? undefined : 'conversation'}
>
  {#if board.props.headerSnippet}
    {@render board.props.headerSnippet()}
  {/if}

  {#if board.submitSpecDecision.showSpecStudio}
    {#if findNavState.studioFindOpen}
      {#await import('./FindInSurface.svelte') then { default: FindInSurface }}
        <FindInSurface
          container={board.state.threadViewElement}
          focusTrigger={findNavState.studioFindFocusTrigger}
          placeholder={`Find in ${board.harnessUsage.studioDocument}…`}
          label="Find in Spec Studio"
          onClose={() => findNavState.closeStudioFind()}
        />
      {/await}
    {/if}
    {#if board.harnessUsage.studioDocument === 'brainstorm' && board.editVideoNote.studioBrainstorm}
      {#key `${board.editVideoNote.studioBrainstorm.id}:${board.editVideoNote.studioBrainstorm.version}:${board.studioReloadNonce.studioReloadNonce}`}
        {#await loadCachedPanelModule(PANEL_KEYS.brainstormStudio, () => import('../specs/BrainstormStudio.svelte'))}
          {@render studioModuleLoading('Brainstorm')}
        {:then { default: BrainstormStudio }}
          <BrainstormStudio
            brainstorm={board.editVideoNote.studioBrainstorm}
            versions={board.editVideoNote.brainstormVersions}
            history={board.composerScope.brainstormStudioHistories.forDocument(
              `${board.editVideoNote.studioBrainstorm.id}:${board.editVideoNote.studioBrainstorm.version}`
            )}
            busy={board.harnessUsage.brainstormBusy || board.switchProject.busy}
            error={board.harnessUsage.brainstormError}
            agentMessagesOpen={workspaceState.specAgentSidebarOpen}
            specAvailable={board.submitBrainstormDecision.spec !== null}
            prdAvailable={board.harnessUsage.prd !== null}
            assignmentAvailable={board.submitSpecDecision.assignment !== null}
            auditAvailable={board.contextUsage.auditReport !== null}
            onBack={board.composerScope.closeSpecStudio}
            onToggleAgentMessages={() =>
              (workspaceState.specAgentSidebarOpen = !workspaceState.specAgentSidebarOpen)}
            onOpenSpec={() => (board.harnessUsage.studioDocument = 'spec')}
            onOpenPrd={board.unmirroredTraceStartTime.openPrdStudio}
            onOpenAssignment={board.submitSpecDecision.openAssignmentStudio}
            onOpenAudit={board.contextUsage.openAuditStudio}
            onSelectVersion={board.editVideoNote.selectBrainstormVersion}
            onSave={board.editVideoNote.saveBrainstorm}
            onAddAnnotation={board.editVideoNote.addBrainstormAnnotation}
            onUpdateAnnotation={board.editVideoNote.updateBrainstormAnnotation}
            onResolveAnnotation={board.editVideoNote.resolveBrainstormAnnotation}
            onExplainSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'brainstorm',
                'elaborate',
                selection,
                documentContext
              )}
            onQuickChatSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'brainstorm',
                'quick',
                selection,
                documentContext
              )}
            onSubmit={board.submitBrainstormDecision.submitBrainstormDecision}
            onNextStep={board.harnessUsage.brainstormNextStep}
            onOpenInEditor={board.composerScope.openBrainstormInEditor}
            onRevealInAppFile={board.composerScope.revealBrainstormInAppFile}
            onOpenPrototype={board.unmirroredTraceStartTime.openPrototypePreview}
            onGenerateHifi={board.editVideoNote.selectLofiPrototype}
          />
        {:catch error}
          {@render studioModuleFailed(PANEL_KEYS.brainstormStudio, 'Brainstorm', error)}
        {/await}
      {/key}
    {:else if board.harnessUsage.studioDocument === 'prd' && board.harnessUsage.studioPrd}
      {#key `${board.harnessUsage.studioPrd.id}:${board.harnessUsage.studioPrd.version}:${board.harnessUsage.studioPrd.updatedAt}:${board.studioReloadNonce.studioReloadNonce}`}
        {#await loadCachedPanelModule(PANEL_KEYS.prdStudio, () => import('../specs/PrdStudio.svelte'))}
          {@render studioModuleLoading('PRD')}
        {:then { default: PrdStudio }}
          <PrdStudio
            prd={board.harnessUsage.studioPrd}
            versions={board.harnessUsage.prdVersions}
            busy={board.harnessUsage.prdBusy || board.switchProject.busy}
            error={board.harnessUsage.prdError}
            brainstormAvailable={board.editVideoNote.brainstorm !== null}
            specAvailable={board.submitBrainstormDecision.spec !== null}
            assignmentAvailable={board.submitSpecDecision.assignment !== null}
            auditAvailable={board.contextUsage.auditReport !== null}
            agentMessagesOpen={workspaceState.specAgentSidebarOpen}
            onBack={board.composerScope.closeSpecStudio}
            onToggleAgentMessages={() =>
              (workspaceState.specAgentSidebarOpen = !workspaceState.specAgentSidebarOpen)}
            onOpenBrainstorm={board.editVideoNote.openBrainstormStudio}
            onOpenSpec={() => (board.harnessUsage.studioDocument = 'spec')}
            onOpenAssignment={board.submitSpecDecision.openAssignmentStudio}
            onOpenAudit={board.contextUsage.openAuditStudio}
            onSelectVersion={board.unmirroredTraceStartTime.selectPrdVersion}
            onSave={board.harnessUsage.savePrd}
            onAddAnnotation={board.harnessUsage.addPrdAnnotation}
            onUpdateAnnotation={board.harnessUsage.updatePrdAnnotation}
            onResolveAnnotation={board.harnessUsage.resolvePrdAnnotation}
            onFinalize={board.harnessUsage.finalizePrd}
            onNextStep={board.harnessUsage.prd?.status === 'finalized'
              ? board.harnessUsage.nextStepFromPrd
              : undefined}
            onOpenInEditor={board.harnessUsage.openPrdInEditor}
            onRevealInFiles={board.harnessUsage.revealPrdInFiles}
          />
        {:catch error}
          {@render studioModuleFailed(PANEL_KEYS.prdStudio, 'PRD', error)}
        {/await}
      {/key}
    {:else if board.harnessUsage.studioDocument === 'audit' && board.contextUsage.auditReport}
      {#key `${board.contextUsage.auditReport.id}:${board.contextUsage.auditReport.version}:${board.studioReloadNonce.studioReloadNonce}`}
        {#await loadCachedPanelModule(PANEL_KEYS.auditStudio, () => import('../specs/AuditStudio.svelte'))}
          {@render studioModuleLoading('Audit')}
        {:then { default: AuditStudio }}
          <AuditStudio
            report={board.contextUsage.auditReport}
            versions={board.buildSpecActionPrompt.auditVersions}
            history={board.composerScope.auditStudioHistories.forDocument(
              `${board.contextUsage.auditReport.id}:${board.contextUsage.auditReport.version}`
            )}
            busy={board.submitSpecDecision.auditBusy || board.switchProject.busy}
            error={board.buildSpecActionPrompt.auditError}
            assignmentAvailable={board.submitSpecDecision.assignment !== null}
            brainstormAvailable={board.editVideoNote.brainstorm !== null}
            prdAvailable={board.harnessUsage.prd !== null}
            specAvailable={board.submitBrainstormDecision.spec !== null}
            actionsAvailable={board.submitSpecDecision.auditReportActionsAvailable}
            agentMessagesOpen={workspaceState.specAgentSidebarOpen}
            onBack={board.composerScope.closeSpecStudio}
            onOpenBrainstorm={board.editVideoNote.openBrainstormStudio}
            onOpenPrd={board.unmirroredTraceStartTime.openPrdStudio}
            onOpenSpec={() => (board.harnessUsage.studioDocument = 'spec')}
            onOpenAssignment={board.submitSpecDecision.openAssignmentStudio}
            onToggleAgentMessages={() =>
              (workspaceState.specAgentSidebarOpen = !workspaceState.specAgentSidebarOpen)}
            onSelectVersion={board.unmirroredTraceStartTime.selectAuditVersion}
            onSave={board.buildSpecActionPrompt.saveAudit}
            onAddAnnotation={board.buildSpecActionPrompt.addAuditAnnotation}
            onUpdateAnnotation={board.buildSpecActionPrompt.updateAuditAnnotation}
            onResolveAnnotation={board.buildSpecActionPrompt.resolveAuditAnnotation}
            onExplainSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'audit',
                'elaborate',
                selection,
                documentContext
              )}
            onQuickChatSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'audit',
                'quick',
                selection,
                documentContext
              )}
            onReview={board.submitSpecDecision.reviewAudit}
            onComplete={board.submitSpecDecision.completeAudit}
            onOpenInEditor={board.buildSpecActionPrompt.openAuditInEditor}
            onRevealInAppFile={board.buildSpecActionPrompt.revealAuditInAppFile}
          />
        {:catch error}
          {@render studioModuleFailed(PANEL_KEYS.auditStudio, 'Audit', error)}
        {/await}
      {/key}
    {:else if board.harnessUsage.studioDocument === 'assignment' && board.submitSpecDecision.assignment && board.unmirroredTraceStartTime.studioAssignment}
      {#key `${board.unmirroredTraceStartTime.studioAssignment.id}:${board.unmirroredTraceStartTime.studioAssignment.version}:${board.studioReloadNonce.studioReloadNonce}`}
        {#await loadCachedPanelModule(PANEL_KEYS.assignmentStudio, () => import('../specs/AssignmentStudio.svelte'))}
          {@render studioModuleLoading('Assignment')}
        {:then { default: AssignmentStudio }}
          <AssignmentStudio
            assignment={board.unmirroredTraceStartTime.studioAssignment}
            threadId={board.handleAgentEvent.thread.id}
            projectId={board.handleAgentEvent.thread.projectId}
            versions={board.submitSpecDecision.assignmentVersions}
            history={board.composerScope.assignmentStudioHistories.forDocument(
              `${board.unmirroredTraceStartTime.studioAssignment.id}:${board.unmirroredTraceStartTime.studioAssignment.version}`
            )}
            providers={board.currentWorkingTraceAttribution.providers}
            harnessId={board.loadOlderMessages.settings.harnessId}
            fallbackModel={board.sources.workerModelForThread()}
            seniorModel={board.composerScope.seniorModelForThread()}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.assignmentBusy || board.switchProject.busy}
            error={board.submitSpecDecision.assignmentError}
            readOnly={board.unmirroredTraceStartTime.studioAssignment.status !== 'draft' ||
              board.unmirroredTraceStartTime.studioAssignment.version !==
                board.submitSpecDecision.assignment.version}
            focusTaskId={board.currentWorkingTraceAttribution.assignmentFocusTaskId}
            agentMessagesOpen={workspaceState.specAgentSidebarOpen}
            auditAvailable={board.contextUsage.auditReport !== null}
            brainstormAvailable={board.editVideoNote.brainstorm !== null}
            prdAvailable={board.harnessUsage.prd !== null}
            specAvailable={board.submitBrainstormDecision.spec !== null}
            auditActive={board.unmirroredTraceStartTime.studioAssignment.version ===
              board.submitSpecDecision.assignment.version &&
              board.buildSpecActionPrompt.assignmentAuditState === 'offered'}
            finalComplete={board.unmirroredTraceStartTime.assignmentFinalComplete}
            onBack={board.composerScope.closeSpecStudio}
            onOpenBrainstorm={board.editVideoNote.openBrainstormStudio}
            onOpenPrd={board.unmirroredTraceStartTime.openPrdStudio}
            onOpenSpec={() => (board.harnessUsage.studioDocument = 'spec')}
            onToggleAgentMessages={() =>
              (workspaceState.specAgentSidebarOpen = !workspaceState.specAgentSidebarOpen)}
            onOpenAudit={board.contextUsage.openAuditStudio}
            onOpenAuditWork={board.buildSpecActionPrompt.openAssignmentAuditWork}
            onSelectVersion={board.unmirroredTraceStartTime.selectAssignmentVersion}
            onSave={board.submitSpecDecision.saveAssignment}
            onApprove={board.submitSpecDecision.approveAssignment}
            onOpenInEditor={board.unmirroredTraceStartTime.openAssignmentInEditor}
            onRevealInAppFile={board.composerScope.revealAssignmentInAppFile}
            onWorkerModelChange={(selection) => board.sources.syncAgentRole('worker', selection)}
            onSeniorModelChange={board.sources.updateAssignmentSeniorModel}
            onTaskModelChange={board.submitSpecDecision.updateAssignmentTaskModel}
            onTaskScopeChange={board.submitSpecDecision.updateAssignmentTaskScope}
            onWorkerScopeChange={board.submitSpecDecision.updateAssignmentWorkerScope}
            assignmentScopeBucketId={board.unmirroredTraceStartTime.assignmentScopeBucketId}
            onOpenTaskThread={(threadId) =>
              void board.currentWorkingTraceAttribution.openAssignmentTaskThread(threadId)}
            resolveTaskThread={board.currentWorkingTraceAttribution.resolveAssignmentTaskThread}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onAddAnnotation={board.submitSpecDecision.addAssignmentAnnotation}
            onUpdateAnnotation={board.submitSpecDecision.updateAssignmentAnnotation}
            onResolveAnnotation={board.submitSpecDecision.resolveAssignmentAnnotation}
            onExplainSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'assignment',
                'elaborate',
                selection,
                documentContext
              )}
            onQuickChatSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'assignment',
                'quick',
                selection,
                documentContext
              )}
          />
        {:catch error}
          {@render studioModuleFailed(PANEL_KEYS.assignmentStudio, 'Assignment', error)}
        {/await}
      {/key}
    {:else if board.submitBrainstormDecision.spec}
      {#key `${board.submitBrainstormDecision.spec.id}:${board.submitBrainstormDecision.spec.version}:${board.studioReloadNonce.studioReloadNonce}`}
        {#await loadCachedPanelModule(PANEL_KEYS.specStudio, () => import('../specs/SpecStudio.svelte'))}
          {@render studioModuleLoading('Spec')}
        {:then { default: SpecStudio }}
          <SpecStudio
            spec={board.submitBrainstormDecision.spec}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            auditSettings={board.contextUsage.auditSettings}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            history={board.composerScope.specStudioHistories.forDocument(
              `${board.submitBrainstormDecision.spec.id}:${board.submitBrainstormDecision.spec.version}`
            )}
            validation={board.unmirroredTraceStartTime.specValidation}
            versions={board.unmirroredTraceStartTime.specVersions}
            busy={board.abortRun.specBusy || board.switchProject.busy}
            error={board.abortRun.specError}
            agentMessagesOpen={workspaceState.specAgentSidebarOpen}
            assignmentAvailable={board.submitSpecDecision.assignment !== null}
            assignmentMode={board.loadOlderMessages.settings.assignmentMode === true}
            auditAvailable={board.contextUsage.auditReport !== null}
            implementationAuditAvailable={board.submitBrainstormDecision
              .plainEngineeringAuditAvailable}
            implementationAuditReady={board.unmirroredTraceStartTime.plainEngineeringAuditReady}
            implementationAuditRunning={board.unmirroredTraceStartTime.plainEngineeringAuditRunning}
            brainstormAvailable={board.editVideoNote.brainstorm !== null}
            prdAvailable={board.harnessUsage.prd !== null}
            onBack={board.composerScope.closeSpecStudio}
            onOpenBrainstorm={board.editVideoNote.openBrainstormStudio}
            onOpenPrd={board.unmirroredTraceStartTime.openPrdStudio}
            onOpenInEditor={board.abortRun.openSpecInEditor}
            onRevealInAppFile={board.abortRun.revealSpecInAppFile}
            onToggleAgentMessages={() =>
              (workspaceState.specAgentSidebarOpen = !workspaceState.specAgentSidebarOpen)}
            onOpenAssignment={board.submitSpecDecision.openAssignmentStudio}
            onGenerateAssignment={() => board.submitSpecDecision.generateAssignmentDraft()}
            onOpenAudit={board.contextUsage.openAuditStudio}
            onRunImplementationAudit={() =>
              board.unmirroredTraceStartTime.plainEngineeringAuditReady
                ? board.contextUsage.openAuditStudio()
                : board.unmirroredTraceStartTime.plainEngineeringAuditRunning
                  ? board.currentWorkingTraceAttribution.openDurableAuditWork()
                  : board.buildSpecActionPrompt.generateAudit(board.contextUsage.auditSettings)}
            onAuditModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onMarkImplementationComplete={board.submitSpecDecision.completeAudit}
            onSave={board.abortRun.saveSpec}
            onSelectVersion={board.unmirroredTraceStartTime.selectSpecVersion}
            onAddAnnotation={board.abortRun.addSpecAnnotation}
            onUpdateAnnotation={board.studioTemporaryChatContext.updateSpecAnnotation}
            onResolveAnnotation={board.composerScope.resolveSpecAnnotation}
            onExplainSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'spec',
                'elaborate',
                selection,
                documentContext
              )}
            onQuickChatSelection={(selection, documentContext) =>
              board.studioTemporaryChatContext.openStudioSelectionChat(
                'spec',
                'quick',
                selection,
                documentContext
              )}
            onDismissValidationIssue={board.composerScope.dismissSpecValidationIssue}
            onSearchContext={board.composerScope.searchSpecContext}
            onAddContext={board.abortRun.addSpecContext}
            onRemoveContext={board.unmirroredTraceStartTime.removeSpecContext}
            onSubmit={board.submitSpecDecision.submitSpecDecision}
          />
        {:catch error}
          {@render studioModuleFailed(PANEL_KEYS.specStudio, 'Spec', error)}
        {/await}
      {/key}
    {:else}
      <div class="flex flex-1 items-center justify-center text-sm text-dimmed">
        {board.abortRun.specBusy
          ? 'Loading specification…'
          : board.abortRun.specError || 'No specification is available.'}
      </div>
    {/if}
  {/if}

  <!-- The conversation stays mounted and only its visibility flips while a studio
       is open. Tearing it down to build the studio's document, and building it
       again on the way back, is every message component in this thread: with a
       long thread that was the whole second the toggle took. `contents` keeps the
       block's children layout children of this column exactly as they were, so
       nothing about the conversation's own layout changes; a hidden block is out
       of layout, out of the accessibility tree, out of the focus order, and out of
       find (which skips `[hidden]`), so it is inert without any bookkeeping. -->
  <div
    class={board.submitSpecDecision.showSpecStudio ? 'hidden' : 'contents'}
    hidden={board.submitSpecDecision.showSpecStudio}
    data-conversation-pane
  >
    {#if board.unmirroredTraceStartTime.showFind}
      {#await import('./FindInSurface.svelte') then { default: FindInSurface }}
        <FindInSurface
          container={board.state.threadViewElement}
          focusTrigger={findNavState.conversationFindFocusTrigger}
          searchSelector={board.state.CONVERSATION_FIND_SELECTOR}
          placeholder="Find in conversation…"
          label="Find in conversation"
          onClose={board.state.closeFind}
        />
      {/await}
    {/if}
    <!-- Scrollable conversation area -->
    <ThreadViewConversation {board} />

    <!-- Bottom-anchored chrome. Everything pinned between the conversation and
         the window edge lives here so the scroll-to-latest button can float at
         the top of the whole stack: straddling an error card when one is shown
         and dropping back to its normal spot above the composer otherwise. -->
    <ThreadViewComposer {board} {composerShoe} {activeActions} {compactionFold} />
  </div>
</div>

<!--
  The coordinator panels are published to the context dock rather than rendered
  here: the thread registers the panel data, the sidebar renders the matching
  component as its own tool, and the thread keeps its full width with a rail
  icon like every other panel.
-->

<ContinueInProjectModal
  open={board.studioTemporaryChatContext.continueInProjectOpen}
  projects={board.props.projects}
  projectIcons={board.props.projectIcons}
  busy={board.studioTemporaryChatContext.continueInProjectBusy}
  onClose={() => {
    if (board.studioTemporaryChatContext.continueInProjectBusy) return
    board.studioTemporaryChatContext.continueInProjectOpen = false
  }}
  onContinue={(project) => board.studioTemporaryChatContext.continueChatInProject(project)}
  onProjectCreated={(project) => void board.props.onProjectCreated?.(project)}
/>

<!-- The destination picker for a relocation or a copy: the same spotlight the
     rest of the app picks from, listing this project's chats in the order the
     project view shows them. Mounted only while a carry is being picked. -->
{#if board.currentWorkingTraceAttribution.relocationRequest}
  <!-- The request travels into the picker's own callback: the palette closes the
       picker before it reports the pick, and that close clears this state. -->
  {@const request = board.currentWorkingTraceAttribution.relocationRequest}
  {#await import('../chats/RelocateThreadPicker.svelte') then { default: RelocateThreadPicker }}
    <RelocateThreadPicker
      projectId={board.handleAgentEvent.thread.projectId}
      projectName={board.composerScope.relocationAssistantId
        ? (board.props.assistantName ?? 'this assistant')
        : (board.contextUsage.project?.name ?? 'this project')}
      assistantId={board.composerScope.relocationAssistantId ?? undefined}
      sourceThreadId={board.handleAgentEvent.thread.id}
      item={request.item}
      mode={request.mode}
      title={board.unmirroredTraceStartTime.relocationPickerTitle}
      onSelect={(picked) =>
        void board.currentWorkingTraceAttribution.commitComposerRelocation(request, picked)}
      onClose={board.unmirroredTraceStartTime.closeRelocationPicker}
    />
  {/await}
{/if}

<TranscriptExportModal
  open={board.sources.transcriptExportOpen}
  chatMode={board.props.chatMode}
  onClose={() => (board.sources.transcriptExportOpen = false)}
  onExport={(includeTrace) => board.sources.exportTranscript(includeTrace)}
/>

<CodexBankedResetConfirm
  open={board.state.showBankedResetConfirm}
  usedPercent={board.contextUsage.contextUsageDisplay?.rateLimits
    .map((window) => window.usedPercent)
    .filter((percent): percent is number => percent !== undefined)
    .reduce((max, percent) => Math.max(max, percent), 0)}
  onClose={() => (board.state.showBankedResetConfirm = false)}
  onConfirm={async () => {
    await board.contextUsage.activateBankedReset()
    board.state.showBankedResetConfirm = false
  }}
/>

<StartAfterThreadPicker
  open={board.state.queuedStartAfterPickerOpen}
  projectId={board.handleAgentEvent.thread.projectId}
  currentThreadId={board.handleAgentEvent.thread.id}
  selectedIds={board.steerQueuedMessage.queuedStartAfterThreads.map((reference) => reference.id)}
  onSelect={board.steerQueuedMessage.addQueuedStartAfterThread}
  onClose={() => (board.state.queuedStartAfterPickerOpen = false)}
/>

<ConfirmDialog
  open={board.steerQueuedMessage.queuedStartAfterPendingRemoval !== null}
  title="Remove wait dependency?"
  onCancel={() => (board.steerQueuedMessage.queuedStartAfterPendingRemoval = null)}
  onConfirm={board.steerQueuedMessage.confirmRemoveQueuedStartAfterThread}
  confirmLabel="Remove dependency"
>
  <p>
    The queued message will no longer wait for
    <span class="font-medium text-foreground"
      >{board.steerQueuedMessage.queuedStartAfterPendingRemoval?.title}</span
    >.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={board.composerScope.studioExitConfirmationOpen}
  title="Leave Spec Studio?"
  onCancel={() => (board.composerScope.studioExitConfirmationOpen = false)}
  onConfirm={() => {
    board.composerScope.studioExitConfirmationOpen = false
    board.composerScope.finishCloseSpecStudio()
  }}
  confirmLabel="Discard changes"
  cancelLabel="Stay"
>
  <p>
    You have unsaved changes in Spec Studio. Leaving will discard those edits and clear this
    session's undo and redo history.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={board.editVideoNote.messagePendingDelete !== null}
  title={board.editVideoNote.deleteConfirmTitle}
  onCancel={board.editVideoNote.cancelDeleteMessage}
  onConfirm={board.editVideoNote.confirmDeleteMessage}
  confirmLabel="Delete"
  note="This cannot be undone."
  busy={board.editVideoNote.deletingMessageId !== null}
>
  <p>{board.editVideoNote.deleteConfirmBody}</p>
</ConfirmDialog>

<EngineeringFlowCancelModal
  open={board.unmirroredTraceStartTime.lifecycleCancelModalOpen}
  oncancel={() => {
    board.unmirroredTraceStartTime.lifecycleCancelModalOpen = false
    // The staged Toolbox choice stays staged (the user toggled it deliberately);
    // only the parked send is discarded   its draft was restored already.
    board.harnessUsage.pendingGuardedSend = null
  }}
  onconfirm={board.harnessUsage.confirmLifecycleReplacement}
/>

<style>
  .thread-view {
    container-type: inline-size;
  }

  /*
   * The conversation and the composer are their own components, so the anchors
   * and gutters this surface's layout owns have to reach their elements. They
   * stay here rather than in those components because the container query below
   * measures this shell.
   */
  :global(.conversation-scroll) {
    overflow-anchor: none;
  }

  @container (max-width: 480px) {
    :global(.conversation-gutter) {
      padding-inline: 0.75rem;
    }

    :global(.composer-gutter) {
      padding-bottom: 0.75rem;
    }
  }
</style>
