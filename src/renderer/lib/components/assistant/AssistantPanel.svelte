<script lang="ts">
  import CioActions from '@pdslng/cio-icon/CioActions.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioBan from '@pdslng/cio-icon/CioBan.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { toast } from 'svelte-sonner'
  import AssistantIcon, {
    type AssistantIconMark
  } from '$lib/components/icons/cio/AssistantIcon.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { assistants } from '$lib/stores/assistants.svelte'
  import type { AssistantPanelTab } from '$lib/stores/context-sidebar-types'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import {
    describeRelativeTime,
    describeSchedule,
    assistantAgentsComplete,
    assistantKnowledgeComplete,
    assistantIsScheduled,
    assistantIsUnnamed,
    type AgentCapabilityCatalog,
    type BackgroundRun,
    type MissedRun,
    type Assistant,
    type AssistantAgents,
    type AssistantConnection,
    type AssistantDeliveryChannel,
    type AssistantImpact,
    type AssistantTimeliness,
    type Thread,
    type UtilityCatalog
  } from '$shared/types'
  import {
    isExternalDeliveryChannel,
    assistantDeliveryChannelLabel,
    assistantDeliveryLabel,
    assistantPriorityLabel,
    ASSISTANT_DELIVERY_OPTIONS,
    ASSISTANT_IMPACT_OPTIONS,
    ASSISTANT_TIMELINESS_OPTIONS
  } from '$shared/assistant-reporting'
  import {
    backgroundRunOutcomeLabel,
    backgroundRunReasonText,
    backgroundRunTone,
    knowledgeSectionSummary,
    parseKnowledgeSections,
    previewRuns,
    resolveConnections,
    serializeKnowledgeSections,
    missedRunReasonText,
    TASK_RUN_PREVIEW,
    type ConnectionSetupRequest,
    type ConnectionView,
    type KnowledgeSection
  } from './assistant-view'
  import {
    buildConnectionLibrary,
    connectionNamesOverlap,
    type ConnectionLibraryEntry
  } from './connection-library'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import CardFoot from '$lib/components/shared/CardFoot.svelte'
  import CardButton from '$lib/components/shared/CardButton.svelte'
  import ConnectionRow from './ConnectionRow.svelte'
  import AssistantAgentPicker from './AssistantAgentPicker.svelte'
  import AssistantExecutionPicker from './AssistantExecutionPicker.svelte'
  import UtilityPicker from './UtilityPicker.svelte'
  import UtilityEditorModal, {
    type UtilityEditorTarget
  } from '$lib/components/settings/UtilityEditorModal.svelte'

  interface Props {
    projectId: string
    threadId: string
    /** Assistant snapshot from the tab; the task's own assistantId wins when set. */
    assistantId: string | null
    /** The section on screen. It is bound to the sidebar tab (not local state)
     *  so switching to another sidebar panel and back reopens the same section
     *  instead of resetting the panel to "All". */
    panelTab: AssistantPanelTab
    navigate: (view: MainView) => void
    /** Open one of the assistant's tasks, so the workspace owns the selection. */
    onOpenTask: (task: Thread) => void
    /**
     * Hand one connection's setup to the workspace, which opens it as a new
     * thread of the assistant: the panel owns the request, the workspace owns
     * thread creation and the selection.
     */
    onSetupConnection: (input: ConnectionSetupRequest) => void
    /**
     * Move a task that belongs to no assistant into one the user picks. Nothing
     * in this view runs without an assistant, so a task with no owner is a
     * question waiting to be answered rather than a working state.
     */
    onAdoptTask?: (task: Thread) => void
  }

  let {
    projectId,
    threadId,
    assistantId,
    panelTab = $bindable(),
    navigate,
    onOpenTask,
    onSetupConnection,
    onAdoptTask
  }: Props = $props()

  const TABS: ReadonlyArray<{ id: AssistantPanelTab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'assistant', label: 'Assistant' },
    { id: 'connections', label: 'Connections' },
    { id: 'agents', label: 'Agents' },
    { id: 'issues', label: 'Issues' }
  ]

  const task = $derived(
    workspaceState.selectedThread?.id === threadId &&
      workspaceState.selectedThread.projectId === projectId
      ? workspaceState.selectedThread
      : (scopeState.allScopeThreads.find(
          (thread) => thread.id === threadId && thread.projectId === projectId
        ) ?? null)
  )

  const assistant = $derived.by((): Assistant | null => {
    // The panel's own assistant id is authoritative: one panel per assistant means
    // selecting another task must never re-target this panel (its anchor task
    // can even belong to a different assistant, e.g. an assistant with no tasks yet).
    // The task's assistant is only a fallback for a panel opened without one.
    const id = assistantId ?? task?.assistantId
    if (!id) return null
    return assistants.assistants.find((candidate) => candidate.id === id) ?? null
  })

  let catalog = $state<UtilityCatalog | null>(null)
  // The Utilities page shows the registry and the capabilities a harness discovers
  // side by side. Loading only the registry here made the picker look half empty.
  let capabilities = $state<AgentCapabilityCatalog | null>(null)

  /**
   * Load the two catalogs the connection library is built from. Re-run after a
   * utility is installed so a connection that was "needs setup" flips to ready
   * without reopening the panel.
   */
  async function loadConnectionLibrary(): Promise<void> {
    try {
      const [utilityCatalog, capabilityCatalog] = await Promise.all([
        invoke('utilities:list'),
        invoke('capabilities:listAll')
      ])
      catalog = utilityCatalog
      capabilities = capabilityCatalog
    } catch {
      // The library stays as it was; a failed refresh must not blank the tab.
    }
  }

  onMount(() => {
    void loadConnectionLibrary()
  })

  /** Every connection the app can offer, registry and harness-discovered alike. */
  const connectionLibrary = $derived(buildConnectionLibrary(catalog, capabilities))

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  let fullscreen = $state(false)

  const visibleTabs = $derived(
    assistant ? TABS : TABS.filter((entry) => entry.id === 'all' || entry.id === 'issues')
  )
  const activeTab = $derived(
    visibleTabs.some((entry) => entry.id === panelTab) ? panelTab : ('all' as AssistantPanelTab)
  )

  /** The status pill's ink: a paused assistant is a warning, a running one is a success. */
  const statusToneColor = $derived(
    assistant?.paused ? 'var(--color-warning)' : 'var(--color-success)'
  )

  /**
   * The count a tab carries, or null when it has nothing worth counting. A zero
   * is noise on a tab label, so every empty section reads as a bare label instead
   * of a badge that says nothing.
   */
  function tabCount(id: AssistantPanelTab): number | null {
    if (id === 'connections') return connectionViews.length || null
    if (id === 'agents') {
      return assistant ? 1 + (assistant.agents?.fallbacks.length ?? 0) : null
    }
    if (id === 'issues') return issueCount || null
    return null
  }

  // ─── Assistant content ──────────────────────────────────────────────────────

  const sections = $derived(assistant ? parseKnowledgeSections(assistant.knowledge) : [])

  /** The one-line summary a folded section shows in place of its body. */
  const sectionSummary = knowledgeSectionSummary
  const knowledgeComplete = $derived(assistant ? assistantKnowledgeComplete(assistant) : false)
  const agentsComplete = $derived(assistant ? assistantAgentsComplete(assistant) : false)
  /** Whether this assistant runs on a clock at all; drives the schedule copy. */
  const scheduled = $derived(assistant ? assistantIsScheduled(assistant) : true)
  /**
   * The schedule line everywhere in the panel: what the user named the clock,
   * then the cadence the assistant agreed, or "runs on demand" when it has none.
   */
  const scheduleLabel = $derived.by(() => {
    if (!scheduled) return 'Runs on demand'
    const cadence = describeSchedule(assistant?.schedule ?? null)
    const named = assistant?.scheduleName?.trim()
    return named ? `${named} · ${cadence}` : cadence
  })

  const collapsed = new SvelteSet<string>()
  /**
   * The assistant's name, for copy that would otherwise repeat "this assistant".
   * An assistant that has not been named yet (the create-by-chat flow starts with
   * no name at all) is described by what it is rather than by a placeholder.
   */
  const assistantLabel = $derived(
    assistant && !assistantIsUnnamed(assistant) ? assistant.name : 'your new assistant'
  )
  let editingId = $state<string | null>(null)
  let editDraft = $state('')

  function toggleSection(id: string): void {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
  }

  function startEdit(section: KnowledgeSection): void {
    editingId = section.id
    editDraft = section.body
    collapsed.delete(section.id)
  }

  function cancelEdit(): void {
    editingId = null
    editDraft = ''
  }

  async function saveSection(sectionId: string): Promise<void> {
    if (!assistant) return
    const next = sections.map((section) =>
      section.id === sectionId ? { ...section, body: editDraft.trim() } : section
    )
    editingId = null
    await persistAssistant(
      { knowledge: serializeKnowledgeSections(next) },
      'Could not save the assistant behavior'
    )
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async function persistAssistant(
    patch: Parameters<typeof assistants.updateAssistant>[1],
    failureMessage: string
  ): Promise<void> {
    if (!assistant) return
    try {
      await assistants.updateAssistant(assistant.id, patch)
    } catch (error) {
      reportError(error, failureMessage)
    }
  }

  async function togglePaused(): Promise<void> {
    if (!assistant) return
    await persistAssistant(
      { paused: !assistant.paused },
      assistant.paused ? 'Could not resume the assistant' : 'Could not pause the assistant'
    )
  }

  function setAgents(agents: AssistantAgents): void {
    void persistAssistant({ agents }, 'Could not save the assistant models')
  }

  // ─── Reporting: where the output goes, and how urgent it is ────────────────

  /** The delivery channels, with a hint saying whether the choice needs a connection. */
  const deliveryChoices = ASSISTANT_DELIVERY_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    hint: option.external
      ? 'Needs a connection this assistant must have'
      : 'A normal thread notification inside CodeInOven'
  }))

  /**
   * Pick the delivery channel. The destination and any note are carried over, so
   * switching channel does not silently discard what the user already told the
   * agent; the in-app channel drops the destination because it has none.
   */
  function setDeliveryChannel(channel: AssistantDeliveryChannel): void {
    if (!assistant) return
    const current = assistant.delivery
    const target = current?.target?.trim()
    void persistAssistant(
      {
        delivery: {
          channel,
          ...(target && channel !== 'in-app' ? { target } : {}),
          ...(current?.note ? { note: current.note } : {})
        }
      },
      'Could not save the delivery channel'
    )
  }

  /** Commit the typed destination. The input is uncontrolled, so this is the only write. */
  function commitDeliveryTarget(raw: string): void {
    if (!assistant) return
    const delivery = assistant.delivery
    if (!delivery || delivery.channel === 'in-app') return
    const target = raw.trim()
    if (target === (delivery.target ?? '')) return
    void persistAssistant(
      {
        delivery: {
          channel: delivery.channel,
          ...(target ? { target } : {}),
          ...(delivery.note ? { note: delivery.note } : {})
        }
      },
      'Could not save the delivery destination'
    )
  }

  function clearDelivery(): void {
    void persistAssistant({ delivery: null }, 'Could not clear the delivery channel')
  }

  /**
   * Set one priority bracket, keeping the other. When the assistant has no
   * priority yet the other bracket starts from the middle of its scale, and the
   * panel immediately shows the pair that was actually saved.
   */
  function setPriorityTimeliness(timeliness: AssistantTimeliness): void {
    if (!assistant) return
    void persistAssistant(
      { priority: { timeliness, impact: assistant.priority?.impact ?? 'team' } },
      'Could not save the priority'
    )
  }

  function setPriorityImpact(impact: AssistantImpact): void {
    if (!assistant) return
    void persistAssistant(
      { priority: { timeliness: assistant.priority?.timeliness ?? 'today', impact } },
      'Could not save the priority'
    )
  }

  function clearPriority(): void {
    void persistAssistant({ priority: null }, 'Could not clear the priority')
  }

  const connectionViews = $derived(
    resolveConnections(assistant?.connections ?? [], catalog, capabilities)
  )
  // A connection that only matched by label still shows as connected, so the
  // picker marks the entry it resolved to rather than the raw stored id.
  const connectedIds = $derived(
    new Set(connectionViews.map((view) => view.entry?.id ?? view.connection.utilityId))
  )
  const connectionProblems = $derived(
    connectionViews.filter((view) => view.status !== 'ready').length
  )

  /**
   * Whether the agreed delivery can actually be honoured: an external channel
   * needs a ready connection whose name matches it. The in-app channel always
   * works, since the app surfaces the run thread itself.
   */
  const deliveryReady = $derived.by(() => {
    const delivery = assistant?.delivery
    if (!delivery || !isExternalDeliveryChannel(delivery.channel)) return true
    const channel = assistantDeliveryChannelLabel(delivery.channel)
    return connectionViews.some(
      (view) => view.status === 'ready' && connectionNamesOverlap(view.connection.label, channel)
    )
  })

  /** The reporting half of the assistant as one line, for the All tab's brief. */
  const reportingBrief = $derived.by(() => {
    if (!assistant) return 'Nothing agreed yet.'
    const parts: string[] = []
    if (assistant.delivery) parts.push(assistantDeliveryLabel(assistant.delivery))
    if (assistant.priority) parts.push(assistantPriorityLabel(assistant.priority))
    if (parts.length === 0) return 'Nothing agreed yet. Ask the agent, or set it here.'
    return parts.join(' \u00b7 ')
  })

  function addConnection(entry: ConnectionLibraryEntry): void {
    if (!assistant) return
    const connections: AssistantConnection[] = [
      ...assistant.connections,
      { utilityId: entry.id, label: entry.name, kind: entry.kind }
    ]
    void persistAssistant({ connections }, 'Could not add the connection')
  }

  /**
   * Removing a connection is destructive, so the row's X only stages it and the
   * shared confirmation dialog commits it. The trigger is a small icon, so a
   * stray click must never drop a connection the assistant depends on.
   */
  let connectionRemoveTarget = $state<AssistantConnection | null>(null)
  let connectionRemoveBusy = $state(false)

  function removeConnection(connection: AssistantConnection): void {
    if (!assistant) return
    connectionRemoveTarget = connection
  }

  async function confirmRemoveConnection(): Promise<void> {
    const connection = connectionRemoveTarget
    if (!assistant || !connection) return
    connectionRemoveBusy = true
    try {
      const connections = assistant.connections.filter(
        (candidate) => candidate.utilityId !== connection.utilityId
      )
      await persistAssistant({ connections }, 'Could not remove the connection')
      connectionRemoveTarget = null
    } finally {
      connectionRemoveBusy = false
    }
  }

  function openUtilities(): void {
    navigate('settings-utilities')
  }

  // ─── Connection setup ─────────────────────────────────────────────────────

  /**
   * The capability modal, opened from a connection that needs attention. A
   * capability the library does not carry yet starts on the create step with
   * the setup prompt the authoring agent recorded; one that exists but is
   * switched off or half-configured opens its own editor instead, since asking
   * the user to add what they already have would be nonsense.
   */
  let connectionSetupOpen = $state(false)
  let connectionSetupTarget = $state<UtilityEditorTarget | null>(null)
  let connectionSetupRequest = $state('')
  /** Label of the connection the modal is showing, used for the setup thread's title. */
  let connectionSetupLabel = $state('')

  function openConnectionDetails(view: ConnectionView): void {
    if (view.entry?.utility) {
      connectionSetupTarget = { kind: 'registry', utility: view.entry.utility }
    } else if (view.entry?.capability) {
      connectionSetupTarget = { kind: 'native', entry: view.entry.capability }
    } else {
      return
    }
    connectionSetupRequest = ''
    connectionSetupLabel = ''
    connectionSetupOpen = true
  }

  function openConnectionSetup(view: ConnectionView): void {
    connectionSetupRequest = view.connection.setup ?? ''
    connectionSetupLabel = view.connection.label
    if (view.entry?.utility) {
      connectionSetupTarget = { kind: 'registry', utility: view.entry.utility }
    } else if (view.entry?.capability) {
      connectionSetupTarget = { kind: 'native', entry: view.entry.capability }
    } else {
      connectionSetupTarget = null
    }
    connectionSetupOpen = true
  }

  /**
   * Run this connection's setup in a thread of its own.
   *
   * The thread belongs to the assistant rather than to the project the user
   * happens to be in: a connection is the assistant's, its setup runs on the
   * assistant's model, and the conversation lands beside the assistant's other
   * tasks where the panel can point the user back at it.
   */
  function setupConnectionInThread(request: string): void {
    const assistantIdValue = assistant?.id
    if (!assistantIdValue) return
    onSetupConnection({
      assistantId: assistantIdValue,
      label: connectionSetupLabel,
      request
    })
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  /**
   * Every thread this panel reports on. A run inherits its task's `assistantId`,
   * so the assistant's runs are in here too: the execution status of a run
   * (working, failed, interrupted) lives on the run thread, not the task.
   */
  const assistantTasks = $derived.by((): Thread[] => {
    if (!assistant) return task ? [task] : []
    return scopeState.allScopeThreads.filter((thread) => thread.assistantId === assistant.id)
  })

  const missedRuns = $derived(
    assistant ? assistants.missedForAssistant(assistant.id) : assistants.missedForTask(threadId)
  )

  /**
   * Ledger-entried unattended runs for this panel's scope: an assistant's runs, or
   * an assistant-less task's own runs, newest first. The ledger keeps working after
   * the run thread is gone, which is why it is evidence beside thread issues.
   */
  const backgroundRuns = $derived(
    assistant
      ? assistants.backgroundForAssistant(assistant.id)
      : assistants.backgroundForTask(threadId)
  )

  let showAllBackgroundRuns = $state(false)

  /** The task a run recorded, resolved from the live thread list when it survives. */
  function runTaskTitle(run: BackgroundRun): string {
    return (
      scopeState.allScopeThreads.find((thread) => thread.id === run.taskId)?.title ??
      'Assistant run'
    )
  }

  /** The run's own thread when it still exists; null once it was deleted. */
  function runThreadFor(run: BackgroundRun): Thread | null {
    return scopeState.allScopeThreads.find((thread) => thread.id === run.runThreadId) ?? null
  }

  /** Run problems: rate limits, waiting on the user, failures, and interrupted
   *  runs. Tasks and their run threads are both checked, since execution status
   *  lives on the run thread. */
  const runIssues = $derived.by(() => {
    const issues: Array<{ id: string; task: Thread; kind: string; detail: string }> = []
    const seen = new SvelteSet<string>()
    const pushIssue = (thread: Thread, kind: string, detail: string): void => {
      const id = `${thread.id}:${kind}`
      if (seen.has(id)) return
      seen.add(id)
      issues.push({ id, task: thread, kind, detail })
    }
    const collectFrom = (thread: Thread): void => {
      const retryAt = agentRuns.retryAt(thread.projectId, thread.id)
      if (retryAt !== null) {
        pushIssue(thread, 'Rate limited', `Retrying ${describeRelativeTime(retryAt, Date.now())}`)
      }
      if (thread.status === 'awaiting_approval') {
        pushIssue(thread, 'Needs attention', 'Waiting on you')
      } else if (thread.status === 'failed') {
        pushIssue(thread, 'Failed', 'The last run failed')
      } else if (thread.status === 'interrupted') {
        pushIssue(thread, 'Interrupted', 'The last run was interrupted')
      }
    }
    for (const entry of assistantTasks) collectFrom(entry)
    for (const run of backgroundRuns) {
      const thread = runThreadFor(run)
      if (thread) collectFrom(thread)
    }
    return issues
  })

  const issueCount = $derived(missedRuns.length + runIssues.length)

  /**
   * The panel's sections as the full screen strip's tabs. The strip carries no
   * badge slot, so the Issues tab puts its count in the title rather than
   * reserving a second one next to the inline header's badge.
   */
  const fullscreenTabs = $derived(
    visibleTabs.map((entry) => ({
      id: entry.id,
      title:
        entry.id === 'issues' && issueCount > 0 ? `${entry.label} · ${issueCount}` : entry.label
    }))
  )

  // ─── Run history ──────────────────────────────────────────────────────────

  /** The run panel is assistant-scoped; an assistant-less task reports on itself. */
  const runScopeTasks = $derived(assistant ? assistantTasks : task ? [task] : [])

  const lastDispatchedAt = $derived(
    runScopeTasks.reduce((latest, entry) => Math.max(latest, entry.lastDispatchedAt ?? 0), 0)
  )
  const lastSuccessAt = $derived(
    runScopeTasks.reduce((latest, entry) => Math.max(latest, entry.lastSuccessAt ?? 0), 0)
  )
  const lastRunLabel = $derived(
    lastDispatchedAt > 0 ? describeRelativeTime(lastDispatchedAt, Date.now()) : 'never'
  )
  const lastSuccessLabel = $derived(
    lastSuccessAt > 0 ? describeRelativeTime(lastSuccessAt, Date.now()) : 'never'
  )

  /** The soonest intended fire across this panel's tasks, or null when none is scheduled. */
  const nextRunAt = $derived.by(() => {
    if (assistant?.paused) return null
    let earliest: number | null = null
    for (const entry of runScopeTasks) {
      const candidate = assistants.nextRunForTask(entry)
      if (candidate === null) continue
      if (earliest === null || candidate < earliest) earliest = candidate
    }
    return earliest
  })
  const nextRunLabel = $derived(
    assistant?.paused ? '-' : nextRunAt === null ? 'Not scheduled' : formatDateTime(nextRunAt)
  )
  const nextRunRelative = $derived(
    nextRunAt === null ? null : describeRelativeTime(nextRunAt, Date.now())
  )
  /**
   * How a slot missed while the app was closed is recovered. Read from the live
   * setting, so the Schedule card states the policy the scheduler actually follows
   * instead of a sentence that can drift from it.
   */
  const missedRunPolicyLabel = $derived(
    appConfigState.autoRunMissedAssistantRuns
      ? 'Caught up on the next launch, at most once.'
      : 'Waits for you in Issues.'
  )

  let running = $state(false)

  // ─── The assistant's knowledge thread ──────────────────────────────────────────

  /**
   * The assistant's knowledge ("Getting started") thread, hidden or not. A hidden
   * row never reaches the hydrated thread list the sidebar renders from, so the
   * panel asks the main process for its own assistant's thread instead of reading
   * the workspace's rows.
   */
  let knowledgeThread = $state<Thread | null>(null)
  let knowledgeThreadBusy = $state(false)

  $effect(() => {
    const assistantIdValue = assistant?.id ?? null
    if (!assistantIdValue) {
      knowledgeThread = null
      return
    }
    // The same target drives the interview checkpoint: the panel is looking at
    // this assistant's knowledge, so the state its authoring conversation agreed is
    // worth having loaded (and the store keeps it fresh from then on).
    void assistants.refreshCheckpoint(assistantIdValue)
    let cancelled = false
    void assistants
      .knowledgeThread(assistantIdValue)
      .then((thread) => {
        if (!cancelled) knowledgeThread = thread
      })
      .catch(() => {
        if (!cancelled) knowledgeThread = null
      })
    return () => {
      cancelled = true
    }
  })

  const knowledgeThreadHidden = $derived(knowledgeThread?.archived === true)

  /**
   * What this assistant's Getting started conversation has agreed so far, as the
   * agent recorded it. The store keeps it current: it loads one when the panel
   * targets an assistant and refreshes it on `assistant:checkpointChanged`, so this
   * is a plain read.
   */
  const gettingStartedCheckpoint = $derived(
    assistant ? (assistants.checkpoints.get(assistant.id) ?? null) : null
  )

  /**
   * Hide or reveal the knowledge thread. It stays pinned either way, so this is
   * the thread's only state change, and revealing also opens the authoring
   * thread so the user lands where the knowledge is written.
   */
  async function toggleKnowledgeThread(): Promise<void> {
    if (!assistant || !knowledgeThread || knowledgeThreadBusy) return
    const revealing = knowledgeThreadHidden
    knowledgeThreadBusy = true
    try {
      const updated = await assistants.setKnowledgeHidden(assistant.id, !revealing)
      knowledgeThread = updated
      if (revealing) onOpenTask(updated)
    } catch (error) {
      reportError(
        error,
        revealing
          ? 'Could not show the assistant behavior thread'
          : 'Could not hide the assistant behavior thread'
      )
    } finally {
      knowledgeThreadBusy = false
    }
  }

  /**
   * Open the assistant's authoring thread from the empty state's "Open the task"
   * action. A hidden thread is revealed first: a hidden row never reaches the
   * sidebar, so opening it without revealing would land the user nowhere.
   */
  function openKnowledgeTask(): void {
    const thread = knowledgeThread
    if (!thread) return
    if (knowledgeThreadHidden) void toggleKnowledgeThread()
    else onOpenTask(thread)
  }

  /**
   * Run the assistant immediately, ignoring its schedule and pause state, so the
   * user can test what they built without waiting for the next fire. Every task
   * runs on a fresh thread, so the first run is opened to show it happening.
   */
  async function runNow(): Promise<void> {
    if (!assistant || !scheduled || running) return
    running = true
    try {
      const runs = await assistants.runNow(assistant.id)
      toast.success(runs.length === 1 ? 'Run started' : `${runs.length} runs started`)
      const first = runs[0]
      if (first) onOpenTask(first)
    } catch (error) {
      reportError(error, 'Could not run the assistant')
    } finally {
      running = false
    }
  }

  async function dismissRun(id: string): Promise<void> {
    try {
      await assistants.dismissMissedRun(id)
    } catch (error) {
      reportError(error, 'Could not dismiss the missed run')
    }
  }

  async function runMissedNow(run: MissedRun): Promise<void> {
    try {
      const created = await assistants.runMissedRunNow(run.id)
      // A run happens on its own thread, so open the run itself.
      if (created) onOpenTask(created)
    } catch (error) {
      reportError(error, 'Could not run the missed task')
    }
  }

  const providers = $derived(providerCatalog.allCached())
  const projectIdForCatalog = $derived(rendererRecovery.selectedProjectId)

  // A picker with an empty catalog is useless, so warm it once when the panel is
  // the first surface to need it. The guard converges as soon as models arrive.
  $effect(() => {
    const catalogProjectId = projectIdForCatalog
    if (!catalogProjectId || providers.length > 0) return
    void providerCatalog.refresh(catalogProjectId).catch(() => undefined)
  })
</script>

{#snippet panelHead()}
  {#if assistant}
    <!--
      The panel opens as a document about one assistant, so its own name, its
      clock and its state sit above the sections rather than inside one tab.
      The status pill is the pause control: the panel has no room for a separate
      row of it, and the state is the one thing that belongs at the top.
    -->
    <header class="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
      <div class="flex items-center gap-2.5">
        <span class="flex h-8 w-8 shrink-0 items-center justify-center bg-primary text-on-primary">
          <AssistantIcon size={20} />
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-[0.875rem] font-semibold tracking-tight text-foreground">
            {assistant.name}
          </h1>
          <p class="mt-0.5 truncate text-[0.6875rem] text-muted">
            {scheduleLabel} · last run {lastRunLabel}
          </p>
        </div>
        <button
          type="button"
          class="shrink-0 border border-border px-1.5 py-0.5 text-[0.5625rem] tracking-wide uppercase transition-colors hover:bg-elevated"
          style="color: {statusToneColor}"
          title={assistant.paused ? 'Resume this assistant' : 'Pause this assistant'}
          aria-label={assistant.paused ? 'Resume this assistant' : 'Pause this assistant'}
          onclick={() => void togglePaused()}
        >
          {assistant.paused ? 'Paused' : 'Running'}
        </button>
      </div>
      {#if assistant.description?.trim()}
        <p class="border-l-2 border-border pl-2.5 text-[0.75rem] leading-relaxed text-muted">
          {assistant.description}
        </p>
      {/if}
    </header>
  {/if}
{/snippet}

{#snippet panelHeader()}
  <div class="flex h-9 shrink-0 items-stretch border-b border-border pr-1">
    <div
      class="flex min-w-0 flex-1 items-stretch overflow-x-auto"
      role="tablist"
      aria-label="Assistant sections"
    >
      {#each visibleTabs as entry (entry.id)}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === entry.id}
          class="relative flex shrink-0 items-center gap-1.5 px-2.5 text-[0.6875rem] whitespace-nowrap transition-colors {activeTab ===
          entry.id
            ? 'text-foreground'
            : 'text-muted hover:text-foreground'}"
          title={entry.label}
          onclick={() => (panelTab = entry.id)}
        >
          {entry.label}
          {#if tabCount(entry.id) !== null}
            <span
              class="border border-border bg-elevated px-1 text-[0.5625rem] tabular-nums"
              style={entry.id === 'issues' ? 'color: var(--color-missed)' : ''}
            >
              {tabCount(entry.id)}
            </span>
          {/if}
          {#if activeTab === entry.id}
            <span class="absolute inset-x-1.5 bottom-0 h-[2px] bg-primary"></span>
          {/if}
        </button>
      {/each}
    </div>
    <button
      type="button"
      class="my-1 flex w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Open in full screen"
      aria-label="Open in full screen"
      onclick={() => (fullscreen = true)}
    >
      <CioMaximize size={13} strokeWidth={1.8} />
    </button>
  </div>
{/snippet}

{#snippet glanceRow(args: {
  title: string
  detail: string
  target: AssistantPanelTab
  icon: AssistantIconMark
  warn?: boolean
})}
  <!--
    The All tab is a table of contents, not a second copy of every section, so
    each line is one door: what the section holds and a way in. The warn line
    wears the missed-run ink on its left edge, which is the only colour an
    assistant surface spends on a problem.
  -->
  <button
    type="button"
    class="flex w-full items-center gap-2.5 border border-border border-l-2 bg-surface px-2.5 py-2 text-left transition-colors hover:bg-elevated"
    style={args.warn
      ? 'border-left-color: var(--color-missed)'
      : 'border-left-color: var(--color-border)'}
    title="Open {args.title}"
    aria-label="Open the {args.title} section"
    onclick={() => (panelTab = args.target)}
  >
    <span class="flex h-7 w-7 shrink-0 items-center justify-center bg-elevated text-foreground">
      <AssistantIcon mark={args.icon} size={16} />
    </span>
    <span class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="text-[0.75rem] font-semibold text-foreground">{args.title}</span>
      <span class="text-[0.625rem] leading-relaxed text-muted">{args.detail}</span>
    </span>
    <span class="shrink-0 text-[0.5625rem] tracking-wide text-dimmed uppercase">Open</span>
  </button>
{/snippet}

{#snippet assistantEmptyState()}
  <div
    class="flex flex-col items-center gap-2.5 border border-border bg-surface px-4 py-8 text-center"
  >
    <span class="flex h-10 w-10 items-center justify-center border border-border bg-elevated">
      <AssistantIcon mark="knowledge" size={24} class="text-dimmed" />
    </span>
    <p class="text-[0.8125rem] font-semibold text-foreground">Nothing yet</p>
    <p class="max-w-[17rem] text-[0.75rem] leading-relaxed text-muted">
      Tell {assistantLabel} what you want in its thread. Tell it the goal, the steps, and when it should
      run. The plan you agree on shows up here.
    </p>
    {#if knowledgeThread}
      <button
        type="button"
        class="mt-1 border border-border px-3 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Open this assistant's behavior thread"
        aria-label="Open this assistant's behavior thread"
        onclick={openKnowledgeTask}
      >
        Open the task
      </button>
    {/if}
  </div>
  {#if gettingStartedCheckpoint}
    <div class="flex flex-col gap-1.5 border border-border bg-surface p-2.5">
      <p class="text-[0.8125rem] font-semibold text-foreground">Agreed so far</p>
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        What you and the agent have agreed for this assistant so far. It is not saved until you
        confirm the recap.
      </p>
      <div class="text-[0.6875rem] text-muted">
        <MarkdownView text={gettingStartedCheckpoint} class="markdown-body-card" />
      </div>
    </div>
  {/if}
{/snippet}

{#snippet noAssistantState()}
  <div class="flex flex-col items-center gap-2.5 px-4 py-9 text-center">
    <span class="flex h-10 w-10 items-center justify-center border border-border bg-elevated">
      <AssistantIcon size={40} class="text-dimmed" />
    </span>
    <p class="text-[0.8125rem] font-medium text-foreground">Not part of an assistant</p>
    <p class="max-w-[17rem] text-[0.75rem] leading-relaxed text-muted">
      Give it to one and it gets instructions, connections, models, and a schedule.
    </p>
    {#if onAdoptTask && task}
      <button
        type="button"
        class="mt-1 bg-primary px-3 py-1.5 text-[0.75rem] text-on-primary transition-colors hover:bg-primary-hover"
        title="Choose the assistant this task belongs to"
        onclick={() => onAdoptTask?.(task)}
      >
        Move it into an assistant
      </button>
    {/if}
  </div>
{/snippet}

{#snippet backgroundRunRowBody(run: BackgroundRun, thread: Thread | null)}
  <span class="mt-0.5 shrink-0">
    <StatusBadge
      tone={backgroundRunTone(run.outcome)}
      title={backgroundRunOutcomeLabel(run.outcome)}
    />
  </span>
  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-1.5">
      <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{runTaskTitle(run)}</span
      >
      <span class="shrink-0 text-[0.625rem] text-muted">
        {backgroundRunOutcomeLabel(run.outcome)}
      </span>
    </span>
    <span class="mt-0.5 block text-[0.625rem] text-dimmed">
      {backgroundRunReasonText(run.reason)} · {formatDateTime(run.startedAt)}
    </span>
    {#if run.outcome === 'failed' && run.errorSummary}
      <span class="mt-0.5 block text-[0.625rem] text-danger">{run.errorSummary}</span>
    {/if}
    {#if run.autoAnswered > 0}
      <span class="mt-0.5 block text-[0.625rem] text-dimmed">
        {run.autoAnswered} decision{run.autoAnswered === 1 ? '' : 's'} answered automatically
      </span>
    {/if}
    {#if !thread}
      <span class="mt-0.5 block text-[0.625rem] text-dimmed italic">
        Run thread deleted. Kept as evidence.
      </span>
    {/if}
  </span>
{/snippet}

{#snippet panelContent()}
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if activeTab === 'all'}
      <div class="flex flex-col gap-3 p-3">
        {#if assistant}
          {#if scheduled}
            <div class="flex flex-col border border-border bg-surface">
              <dl class="flex flex-wrap gap-x-5 gap-y-2 p-3">
                <div class="flex flex-col gap-0.5">
                  <dt
                    class="text-[0.5625rem] tracking-wide text-dimmed uppercase"
                    title="The last time a run was dispatched"
                  >
                    Last run
                  </dt>
                  <dd class="text-[0.75rem] text-foreground">{lastRunLabel}</dd>
                </div>
                <div class="flex flex-col gap-0.5">
                  <dt
                    class="text-[0.5625rem] tracking-wide text-dimmed uppercase"
                    title="The last time a run finished successfully"
                  >
                    Last success
                  </dt>
                  <dd class="text-[0.75rem] text-foreground">{lastSuccessLabel}</dd>
                </div>
                <div class="flex flex-col gap-0.5">
                  <dt
                    class="text-[0.5625rem] tracking-wide text-dimmed uppercase"
                    title="The next time this assistant is due to run"
                  >
                    Next run
                  </dt>
                  <dd class="text-[0.75rem] text-foreground">{nextRunLabel}</dd>
                </div>
              </dl>
              <CardFoot>
                {#snippet left()}
                  <p class="text-[0.6875rem] leading-relaxed text-muted">
                    {knowledgeComplete
                      ? 'Run a task now without waiting for the schedule.'
                      : 'Save the assistant instructions first.'}
                  </p>
                {/snippet}
                {#snippet right()}
                  <CardButton
                    label="Run now"
                    title="Run a task now, even while the assistant is paused"
                    icon={CioUndo}
                    variant="primary"
                    loading={running}
                    disabled={running || !knowledgeComplete}
                    onclick={() => void runNow()}
                  />
                {/snippet}
              </CardFoot>
            </div>
          {/if}

          <ul class="flex flex-col gap-2">
            <li>
              {@render glanceRow({
                title: 'Assistant',
                icon: 'knowledge',
                detail: knowledgeComplete
                  ? `${sections.length} section${sections.length === 1 ? '' : 's'} · ${scheduleLabel}`
                  : 'No behavior yet. Describe the assistant to the agent in its task.',
                target: 'assistant',
                warn: !knowledgeComplete
              })}
            </li>
            <li>
              {@render glanceRow({
                title: 'Connections',
                icon: 'connection',
                detail:
                  connectionViews.length === 0
                    ? 'No connections yet.'
                    : connectionProblems === 0
                      ? `${connectionViews.length} connected and ready.`
                      : `${connectionProblems} of ${connectionViews.length} need setup.`,
                target: 'connections',
                warn: connectionProblems > 0
              })}
            </li>
            <li>
              {@render glanceRow({
                title: 'Agents',
                icon: 'agent',
                detail: agentsComplete
                  ? `${1 + (assistant.agents?.fallbacks.length ?? 0)} models: a primary and its fallbacks.`
                  : 'No model set. Add a primary and fallbacks on the Agents tab.',
                target: 'agents',
                warn: !agentsComplete
              })}
            </li>
            <li>
              {@render glanceRow({
                title: 'Reporting',
                icon: 'assistant',
                detail: reportingBrief,
                target: 'assistant',
                warn: !deliveryReady
              })}
            </li>
            {#if scheduled || issueCount > 0}
              <li>
                {@render glanceRow({
                  title: 'Issues',
                  icon: 'run',
                  detail:
                    issueCount === 0
                      ? 'Nothing needs attention.'
                      : `${missedRuns.length} missed · ${runIssues.length} run issue${runIssues.length === 1 ? '' : 's'}.`,
                  target: 'issues',
                  warn: issueCount > 0
                })}
              </li>
            {/if}
          </ul>
        {:else}
          {@render noAssistantState()}
        {/if}
      </div>
    {:else if activeTab === 'assistant'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <div class="flex flex-col gap pl-3">
          {#if !knowledgeComplete}
            {@render assistantEmptyState()}
          {:else}
            {#if assistant.personality?.trim()}
              <div class="border border-border bg-surface px-2.5 py-2">
                <p
                  class="mb-1 text-[0.625rem] font-medium text-dimmed"
                  title="How this assistant behaves and sounds"
                >
                  Personality
                </p>
                <p class="text-[0.6875rem] leading-relaxed text-muted">{assistant.personality}</p>
              </div>
            {/if}
            <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
              <div class="flex items-center justify-between gap-2">
                <h2 class="text-[0.875rem] font-semibold text-foreground">Assistant behavior</h2>
                <span class="text-[0.625rem] text-dimmed"
                  >{sections.length} {sections.length === 1 ? 'section' : 'sections'}</span
                >
              </div>
              <p class="text-[0.6875rem] leading-relaxed text-muted">
                The instructions this assistant follows on every run. The agent follows them
                literally, so anything not written here does not happen.
              </p>
              <ol class="flex flex-col gap-2">
                {#each sections as section (section.id)}
                  {@const folded = collapsed.has(section.id) && editingId !== section.id}
                  <li class="border-t border-border first:border-t-0">
                    <div class="flex items-center gap-1.5 px-2.5 py-1.5">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        aria-expanded={!folded}
                        title={folded ? `Expand ${section.title}` : `Fold ${section.title}`}
                        onclick={() => toggleSection(section.id)}
                      >
                        <CioForward
                          size={12}
                          strokeWidth={1.8}
                          class="shrink-0 text-dimmed transition-transform duration-150 {folded
                            ? ''
                            : 'rotate-90'}"
                        />
                        <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                          {section.title}
                        </span>
                      </button>
                      {#if editingId !== section.id}
                        <button
                          type="button"
                          class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                          title="Edit {section.title}"
                          aria-label="Edit {section.title}"
                          onclick={() => startEdit(section)}
                        >
                          <CioPencil size={12} strokeWidth={1.8} />
                        </button>
                      {/if}
                    </div>

                    {#if editingId === section.id}
                      <div class="border-t border-border p-2">
                        <!-- The editor grows with its content (no `max-h` cap) so a long
                       section keeps the same tall box the read view showed instead
                       of collapsing into a short scroll pane on edit. The panel's
                       content already scrolls, so an overlong body is still safe. -->
                        <RichMarkdownEditor
                          id="assistant-section-{section.id}"
                          value={editDraft}
                          onValueChange={(value) => (editDraft = value)}
                          placeholder="Write this section in Markdown…"
                          ariaLabel="Edit {section.title}"
                          autofocus
                          onSubmit={() => void saveSection(section.id)}
                          containerClass="border border-border bg-surface"
                          class="min-h-10 w-full px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
                        />
                        <div class="mt-1.5 flex justify-end gap-1.5">
                          <button
                            type="button"
                            class="px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                            onclick={cancelEdit}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            class="bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
                            onclick={() => void saveSection(section.id)}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    {:else if !folded}
                      <div class="border-t border-border px-2.5 py-2">
                        <MarkdownView text={section.body} class="text-[0.75rem]" />
                      </div>
                    {:else if sectionSummary(section)}
                      <!-- A folded section keeps one line of its own prose, so folding
                     hides detail without hiding what the section is about. -->
                      <p class="border-t border-border px-2.5 py-1.5 text-[0.6875rem] text-dimmed">
                        {sectionSummary(section)}
                      </p>
                    {/if}
                  </li>
                {/each}
              </ol>
            </div>
          {/if}

          <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
            <h2 class="text-[0.875rem] font-semibold text-foreground">Schedule</h2>
            <dl class="flex flex-col">
              <div
                class="flex items-start justify-between gap-4 border-t border-border py-1.5 first:border-t-0"
              >
                <dt class="text-[0.75rem] text-muted">Runs</dt>
                <dd class="text-right text-[0.75rem] text-foreground">{scheduleLabel}</dd>
              </div>
              <div class="flex items-start justify-between gap-4 border-t border-border py-1.5">
                <dt class="text-[0.75rem] text-muted">Next run</dt>
                <dd class="text-right text-[0.75rem] text-foreground">
                  {nextRunLabel}
                  {#if nextRunRelative && nextRunRelative !== 'now'}
                    <span class="ml-1 text-dimmed">{nextRunRelative}</span>
                  {/if}
                </dd>
              </div>
              <div class="flex items-start justify-between gap-4 border-t border-border py-1.5">
                <dt class="text-[0.75rem] text-muted">If a run is missed</dt>
                <dd class="text-right text-[0.75rem] text-foreground">{missedRunPolicyLabel}</dd>
              </div>
            </dl>
          </div>

          <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
            <div class="flex items-center gap-1.5">
              <h2 class="text-[0.875rem] font-semibold text-foreground">Reporting</h2>
              {#if !deliveryReady}
                <span
                  class="flex items-center"
                  style="color: var(--color-warning)"
                  role="img"
                  aria-label="The delivery channel needs a connection"
                  title="The delivery channel needs a connection"
                >
                  <CioAttention size={11} strokeWidth={2} />
                </span>
              {/if}
            </div>
            <p class="text-[0.6875rem] leading-relaxed text-muted">
              Where this assistant's output goes, and how urgent it is. Agree it with the agent, or
              set it here.
            </p>
            <div class="flex flex-col">
              <div
                class="flex items-center justify-between gap-3 border-t border-border py-2 first:border-t-0"
              >
                <span class="shrink-0 text-[0.75rem] text-muted">Deliver to</span>
                <div class="flex min-w-0 flex-1 items-center gap-1">
                  <EnumSelect
                    options={deliveryChoices}
                    value={assistant.delivery?.channel ?? null}
                    onChange={setDeliveryChannel}
                    placeholder="Delivery channel"
                    ariaLabel="Delivery channel"
                    title="Where this assistant's output is delivered"
                    class="flex-1"
                  />
                  {#if assistant.delivery}
                    <button
                      type="button"
                      class="shrink-0 px-1.5 py-1 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                      title="Clear the delivery channel"
                      aria-label="Clear the delivery channel"
                      onclick={clearDelivery}
                    >
                      Clear
                    </button>
                  {/if}
                </div>
              </div>

              {#if assistant.delivery && assistant.delivery.channel !== 'in-app'}
                <div class="border-t border-border py-2">
                  <input
                    type="text"
                    class="w-full border border-border bg-elevated px-2.5 py-1.5 text-[0.75rem] text-foreground outline-none transition-colors placeholder:text-dimmed focus-visible:ring-2 focus-visible:ring-primary"
                    placeholder="Destination: a chat, a channel, an address"
                    aria-label="Delivery destination"
                    title="The concrete destination, for example #eng-alerts"
                    value={assistant.delivery.target ?? ''}
                    onblur={(event) => commitDeliveryTarget(event.currentTarget.value)}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') event.currentTarget.blur()
                    }}
                  />
                </div>
              {/if}

              {#if assistant.delivery && !deliveryReady}
                <p
                  class="border-t border-border py-2 text-[0.625rem] leading-relaxed"
                  style="color: var(--color-warning)"
                >
                  {assistantDeliveryChannelLabel(assistant.delivery.channel)} is not connected yet. Add
                  it on the Connections tab; until then runs deliver in CodeInOven.
                </p>
              {/if}

              <div class="flex items-center justify-between gap-3 border-t border-border py-2">
                <span class="shrink-0 text-[0.75rem] text-muted">Timeliness</span>
                <div class="flex min-w-0 flex-1 items-center gap-1">
                  <EnumSelect
                    options={ASSISTANT_TIMELINESS_OPTIONS}
                    value={assistant.priority?.timeliness ?? null}
                    onChange={setPriorityTimeliness}
                    placeholder="Timeliness"
                    ariaLabel="Time-based priority"
                    title="How soon this assistant's output matters"
                    class="flex-1"
                  />
                </div>
              </div>

              <div class="flex items-center justify-between gap-3 border-t border-border py-2">
                <span class="shrink-0 text-[0.75rem] text-muted">Impact</span>
                <div class="flex min-w-0 flex-1 items-center gap-1">
                  <EnumSelect
                    options={ASSISTANT_IMPACT_OPTIONS}
                    value={assistant.priority?.impact ?? null}
                    onChange={setPriorityImpact}
                    placeholder="Impact"
                    ariaLabel="Scope-based priority"
                    title="How far this assistant's output reaches"
                    class="flex-1"
                  />
                  {#if assistant.priority}
                    <button
                      type="button"
                      class="shrink-0 px-1.5 py-1 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                      title="Clear the priority"
                      aria-label="Clear the priority"
                      onclick={clearPriority}
                    >
                      Clear
                    </button>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        </div>
      {/if}
    {:else if activeTab === 'connections'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <div class="flex flex-col gap-4 p-3">
          <p class="text-[0.6875rem] leading-relaxed text-muted">
            Connect the services this assistant needs to do its work. Review their status, finish
            setup, or add another connection below.
          </p>
          <div class="flex flex-col gap-2">
            {#each connectionViews as view (view.connection.utilityId)}
              <ConnectionRow
                {view}
                onRemove={removeConnection}
                onSetup={openConnectionSetup}
                onView={openConnectionDetails}
              />
            {/each}
          </div>
          <UtilityPicker
            entries={connectionLibrary}
            {connectedIds}
            label="Add a connection"
            onSelect={addConnection}
            onOpenLibrary={openUtilities}
          />
        </div>
      {/if}
    {:else if activeTab === 'agents'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <div class="flex flex-col gap-4 p-3">
          <p class="text-[0.6875rem] leading-relaxed text-muted">
            Choose where this assistant runs and which AI model does its work. Add fallback models
            to use if the primary model is unavailable.
          </p>
          {#key assistant.id}
            <div class="border border-border bg-surface p-2.5">
              <AssistantExecutionPicker
                assistantId={assistant.id}
                execution={assistant.execution}
              />
            </div>
            <div class="border border-border bg-surface p-2.5">
              <AssistantAgentPicker
                agents={assistant.agents}
                {providers}
                projectId={projectIdForCatalog}
                onChange={setAgents}
              />
            </div>
          {/key}
        </div>
      {/if}
    {:else}
      <div class="flex flex-col gap-3 pl-3">
        <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
          <h2 class="text-[0.875rem] font-semibold text-foreground">Missed runs</h2>
          {#if missedRuns.length === 0}
            <p class="text-[0.6875rem] text-dimmed">No scheduled run has been missed.</p>
          {:else}
            <div class="flex flex-col gap-2">
              {#each missedRuns as run (run.id)}
                <div class="flex flex-col gap-1.5 bg-elevated p-2.5">
                  <div class="flex items-center gap-2">
                    <CioAttention size={13} strokeWidth={1.8} style="color: var(--color-missed)" />
                    <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                      {run.title}
                    </span>
                  </div>
                  <p class="text-[0.625rem] text-dimmed">
                    Was due {formatDateTime(run.dueAt)}. {missedRunReasonText(run.reason)}
                  </p>
                  <div class="flex justify-end gap-1.5">
                    <button
                      type="button"
                      class="px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      title="Dismiss this missed run"
                      aria-label="Dismiss the missed run {run.title}"
                      onclick={() => void dismissRun(run.id)}
                    >
                      Dismiss
                    </button>
                    {#if scheduled}
                      <button
                        type="button"
                        class="flex items-center gap-1 bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
                        title="Run this missed sweep now"
                        aria-label="Run the missed run {run.title} now"
                        onclick={() => void runMissedNow(run)}
                      >
                        <CioUndo size={12} strokeWidth={1.8} />
                        Run now
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
          <h2 class="text-[0.875rem] font-semibold text-foreground">Run problems</h2>
          {#if runIssues.length === 0}
            <p class="text-[0.6875rem] text-dimmed">
              No waiting runs, rate limits, failures or interruptions.
            </p>
          {:else}
            <div class="flex flex-col">
              {#each runIssues as issue (issue.id)}
                <button
                  type="button"
                  class="flex items-start gap-2 border-t border-border py-2 text-left transition-colors first:border-t-0 hover:bg-elevated"
                  title="Open {issue.task.title}"
                  aria-label="Open {issue.task.title}"
                  onclick={() => onOpenTask(issue.task)}
                >
                  <span class="mt-0.5 shrink-0" style="color: var(--color-warning)">
                    {#if issue.kind === 'Rate limited'}
                      <CioActions size={13} strokeWidth={1.8} />
                    {:else if issue.kind === 'Interrupted'}
                      <CioBan size={13} strokeWidth={1.8} />
                    {:else}
                      <CioAttention size={13} strokeWidth={1.8} />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="flex items-center gap-1.5">
                      <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                        {issue.task.title}
                      </span>
                      <span class="shrink-0 text-[0.625rem] text-muted">{issue.kind}</span>
                    </span>
                    <span class="mt-0.5 block text-[0.625rem] text-dimmed">{issue.detail}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
          <h2 class="text-[0.875rem] font-semibold text-foreground">Run history</h2>
          {#if backgroundRuns.length === 0}
            <p class="text-[0.6875rem] text-dimmed">No unattended runs recorded yet.</p>
          {:else}
            <div class="flex flex-col">
              {#each previewRuns(backgroundRuns, showAllBackgroundRuns) as run (run.runThreadId)}
                {@const thread = runThreadFor(run)}
                {#if thread}
                  <button
                    type="button"
                    class="flex items-start gap-2 border-t border-border py-2 text-left transition-colors first:border-t-0 hover:bg-elevated"
                    title="Open this run"
                    aria-label="Open unattended run for {runTaskTitle(run)}"
                    onclick={() => onOpenTask(thread)}
                  >
                    {@render backgroundRunRowBody(run, thread)}
                  </button>
                {:else}
                  <div
                    class="flex items-start gap-2 border-t border-border py-2 first:border-t-0"
                    title="The run's thread was deleted; this record is the evidence it ran"
                  >
                    {@render backgroundRunRowBody(run, null)}
                  </div>
                {/if}
              {/each}
              {#if backgroundRuns.length > TASK_RUN_PREVIEW}
                <button
                  type="button"
                  class="self-start border-t border-border px-2 py-1 text-[0.6875rem] text-muted transition-colors first:border-t-0 hover:bg-elevated hover:text-foreground"
                  title={showAllBackgroundRuns ? 'Show fewer runs' : 'Show every recorded run'}
                  aria-label={showAllBackgroundRuns
                    ? 'Show fewer runs'
                    : `Show all ${backgroundRuns.length} runs`}
                  onclick={() => (showAllBackgroundRuns = !showAllBackgroundRuns)}
                >
                  {showAllBackgroundRuns ? 'Show fewer' : `Show all ${backgroundRuns.length}`}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet knowledgeThreadAction()}
  {#if assistant && knowledgeThread}
    <!-- The knowledge thread is pinned for life and has exactly two states. Hide
         puts it away for the session, Show brings it back and opens it, so the
         panel is always the way back to the assistant's authoring thread. -->
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title={knowledgeThreadHidden
        ? 'Show the assistant behavior thread again'
        : 'Hide the assistant behavior thread from the sidebar'}
      disabled={knowledgeThreadBusy}
      onclick={() => void toggleKnowledgeThread()}
    >
      <AssistantIcon mark="knowledge" size={14} class="shrink-0" />
      <span class="truncate">
        {knowledgeThreadHidden
          ? 'Show assistant behavior thread'
          : 'Hide assistant behavior thread'}
      </span>
    </button>
  {/if}
{/snippet}

{#if !fullscreen}
  <div class="flex h-full min-h-0 flex-col" aria-label="Assistant panel">
    {@render panelHead()}
    {@render panelHeader()}
    {@render panelContent()}
    {@render knowledgeThreadAction()}
  </div>
{/if}

{#if fullscreen}
  <!--
    The full screen render reuses the app's full screen surface, so it shares the
    draggable title bar, the traffic-light inset and the canonical minimize with
    the browser, terminal and pull request reader. The panel's own sections are
    the strip's tabs, which is why this surface passes neither `onNew` nor
    `onCloseTab`: a section is switched, not opened or closed.
  -->
  <FullscreenPanelDialog
    tabs={fullscreenTabs}
    activeTabId={activeTab}
    minimizeLabel="Exit full screen"
    onSelect={(id) => (panelTab = id as AssistantPanelTab)}
    onMinimize={() => (fullscreen = false)}
  >
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      {@render panelHead()}
      {@render panelContent()}
    </div>
    {@render knowledgeThreadAction()}
  </FullscreenPanelDialog>
{/if}

{#if connectionSetupOpen}
  <!--
    The same Add capability modal the Utilities page uses, opened from a
    connection that still needs setup. Its assisted path is seeded with the
    prompt the authoring agent recorded and opens a setup thread of this
    assistant; the library is reloaded afterwards, so a capability installed
    through the editor flips the row to ready in place.
  -->
  <UtilityEditorModal
    open
    target={connectionSetupTarget}
    setupRequestSeed={connectionSetupRequest}
    onOpenSetupThread={setupConnectionInThread}
    onClose={() => (connectionSetupOpen = false)}
    onChanged={() => void loadConnectionLibrary()}
    onSaved={() => void loadConnectionLibrary()}
  />
{/if}

<ConfirmDialog
  open={connectionRemoveTarget !== null}
  title="Remove connection"
  confirmLabel="Remove connection"
  busy={connectionRemoveBusy}
  onCancel={() => (connectionRemoveTarget = null)}
  onConfirm={confirmRemoveConnection}
>
  <p>
    Remove <strong class="text-foreground">{connectionRemoveTarget?.label ?? ''}</strong> from this assistant?
    The agent will no longer use it when this assistant runs.
  </p>
</ConfirmDialog>
