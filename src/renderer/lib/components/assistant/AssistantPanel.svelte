<script lang="ts">
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { toast } from 'svelte-sonner'
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getAssistantIcon } from '$lib/assistant-icons'
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
    assistantIsScheduled,
    assistantKnowledgeComplete,
    type AgentCapabilityCatalog,
    type BackgroundRun,
    type MissedRun,
    type Assistant,
    type AssistantAgents,
    type AssistantConnection,
    type Thread,
    type UpdateAssistantInput,
    type UtilityCatalog
  } from '$shared/types'
  import {
    isExternalDeliveryChannel,
    assistantDeliveryChannelLabel,
    assistantDeliveryLabel,
    assistantPriorityLabel
  } from '$shared/assistant-reporting'
  import {
    assistantKnowledgeSections,
    parseKnowledgeSections,
    resolveConnections,
    serializeKnowledgeSections,
    withKnowledgePersonality,
    type ConnectionSetupRequest,
    type ConnectionView
  } from './assistant-view'
  import {
    buildConnectionLibrary,
    connectionNamesOverlap,
    type ConnectionLibraryEntry
  } from './connection-library'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import AssistantWakesSection from '$lib/components/assistant/AssistantWakesSection.svelte'
  import { followUpsState } from '$lib/stores/follow-ups.svelte'
  import ConnectionRow from './ConnectionRow.svelte'
  import AssistantAgentPicker from './AssistantAgentPicker.svelte'
  import AssistantExecutionPicker from './AssistantExecutionPicker.svelte'
  import UtilityPicker from './UtilityPicker.svelte'
  import AssistantOverviewTab from './assistant-panel/AssistantOverviewTab.svelte'
  import AssistantBehaviourTab from './assistant-panel/AssistantBehaviourTab.svelte'
  import AssistantScheduleTab from './assistant-panel/AssistantScheduleTab.svelte'
  import AssistantReportingTab from './assistant-panel/AssistantReportingTab.svelte'
  import AssistantIssuesTab from './assistant-panel/AssistantIssuesTab.svelte'
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

  /**
   * The strip, in reading order: what the assistant is and how it works first,
   * then what it uses and what needs the user, and last the three sections that
   * only earn a tab when they hold something (when it runs, what it is waiting
   * on, and where its output goes). Keeping those three at the end means the
   * strip only grows past Issues for an assistant that actually has the state.
   */
  const TABS: ReadonlyArray<{ id: AssistantPanelTab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'behaviour', label: 'Behaviour' },
    { id: 'connections', label: 'Connections' },
    { id: 'agents', label: 'Agents' },
    { id: 'issues', label: 'Issues' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'wakes', label: 'Wakes' },
    { id: 'reporting', label: 'Reporting' }
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

  /**
   * The section on screen. A hidden tab can still be selected from its row on
   * **All**, so the selected id is honoured even when the strip does not carry it:
   * the body renders and no tab reads as active, rather than the page silently
   * snapping back to All.
   */
  const activeTab = $derived(
    TABS.some((entry) => entry.id === panelTab) ? panelTab : ('all' as AssistantPanelTab)
  )

  /**
   * The mark this assistant wears: the image or SVG icon the user picked for it,
   * tinted with its accent, resolved exactly as the sidebar row resolves it. The
   * panel used to draw the default mark for every assistant, so the icon the user
   * chose never appeared on the one surface that documents it.
   */
  const assistantIcon = $derived(
    assistant ? getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null) : null
  )

  /**
   * The clock, as every surface in the panel reads it: whether one exists, and the
   * line naming it. It sits here rather than in the schedule tab because the header
   * and the All tab both state it.
   */
  const scheduled = $derived(assistant ? assistantIsScheduled(assistant) : true)
  const scheduleAgreed = $derived(Boolean(assistant?.schedule))
  const scheduleLabel = $derived.by(() => {
    if (!scheduled) return 'Runs on demand'
    const cadence = describeSchedule(assistant?.schedule ?? null)
    const named = assistant?.scheduleName?.trim()
    return named ? `${named} · ${cadence}` : cadence
  })

  /** The behaviour's size, for the All tab's table of contents. */
  const sectionCount = $derived(
    assistant ? assistantKnowledgeSections(assistant.knowledge).length : 0
  )
  const knowledgeComplete = $derived(assistant ? assistantKnowledgeComplete(assistant) : false)
  const agentsComplete = $derived(assistant ? assistantAgentsComplete(assistant) : false)
  const agentCount = $derived(1 + (assistant?.agents?.fallbacks.length ?? 0))

  /**
   * The count a tab carries, or null when it has nothing worth counting. A zero
   * is noise on a tab label, so every empty section reads as a bare label instead
   * of a badge that says nothing.
   */
  function tabCount(id: AssistantPanelTab): number | null {
    if (id === 'connections') return connectionViews.length || null
    if (id === 'agents') return assistant ? agentCount : null
    if (id === 'wakes') return wakes.length || null
    if (id === 'issues') return issueCount || null
    return null
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async function persistAssistant(
    patch: UpdateAssistantInput,
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

  /**
   * Write one behaviour section back into the knowledge document.
   *
   * The personality is written as its own section; every other row rewrites the
   * section it was opened from, in the document's own order. The whole parsed
   * document is rewritten, not the filtered rows, so a save can never drop the
   * personality section it did not edit.
   */
  async function saveSection(sectionId: string, body: string): Promise<void> {
    if (!assistant) return
    const knowledge =
      sectionId === 'personality'
        ? withKnowledgePersonality(assistant.knowledge, body)
        : serializeKnowledgeSections(
            parseKnowledgeSections(assistant.knowledge).map((section) =>
              section.id === sectionId ? { ...section, body } : section
            )
          )
    await persistAssistant({ knowledge }, 'Could not save the assistant behavior')
  }

  // ─── Reporting: where the output goes, and how urgent it is ────────────────

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

  // ─── Wakes ────────────────────────────────────────────────────────────────

  /**
   * Every thread this panel reports on. A run inherits its task's `assistantId`,
   * so the assistant's runs are in here too: the execution status of a run
   * (working, failed, interrupted) lives on the run thread, not the task.
   */
  const assistantTasks = $derived.by((): Thread[] => {
    if (!assistant) return task ? [task] : []
    return scopeState.allScopeThreads.filter((thread) => thread.assistantId === assistant.id)
  })

  /** Wakes armed on this assistant's own threads, newest first as the store holds them. */
  const wakes = $derived(followUpsState.forThreads(assistantTasks.map((entry) => entry.id)))

  // ─── Which sections earn a tab ────────────────────────────────────────────

  /**
   * Whether a section has anything to show yet. A section with no state keeps its
   * row on **All** (so the state is still stated and the row still opens it, see
   * `activeTab`); what it loses is a strip tab that would otherwise restate
   * "nothing here". Three sections are conditional, so a quiet assistant is All,
   * Behaviour, Connections, Agents, Issues and no clutter.
   */
  const scheduleTabVisible = $derived(Boolean(assistant && scheduleAgreed && scheduled))
  const wakesTabVisible = $derived(wakes.length > 0)
  const reportingTabVisible = $derived(Boolean(assistant?.delivery || assistant?.priority))

  /**
   * The strip's entries: every section of a real assistant, minus the conditional
   * ones that hold nothing. A task with no assistant has no behaviour, clock,
   * reporting, wakes or models to show, so it keeps only the two sections that
   * still apply to it.
   */
  const visibleTabs = $derived.by(() => {
    if (!assistant) {
      return TABS.filter((entry) => entry.id === 'all' || entry.id === 'issues')
    }
    return TABS.filter((entry) => {
      if (entry.id === 'schedule') return scheduleTabVisible
      if (entry.id === 'wakes') return wakesTabVisible
      if (entry.id === 'reporting') return reportingTabVisible
      return true
    })
  })

  // ─── Issues ───────────────────────────────────────────────────────────────

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
   * The panel's tabs as the full screen strip's tabs. The strip carries no badge
   * slot, so the Issues tab puts its count in the title rather than reserving a
   * second one next to the inline header's badge.
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
   * setting, so the Schedule tab states the policy the scheduler actually follows
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
          ? 'Could not show the Getting started thread'
          : 'Could not hide the Getting started thread'
      )
    } finally {
      knowledgeThreadBusy = false
    }
  }

  /**
   * Open the assistant's authoring thread. A hidden thread is revealed first: a
   * hidden row never reaches the sidebar, so opening it without revealing would
   * land the user nowhere.
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
      clock and its state sit above the tabs rather than inside one of them.
      The status pill is the pause control: the panel has no room for a separate
      row of it, and the state is the one thing that belongs at the top.
    -->
    <header class="flex shrink-0 flex-col gap-2 border-b border-border px-3 py-2.5">
      <div class="flex items-center gap-2.5">
        <span
          class="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-elevated"
        >
          {#if assistantIcon}
            <img src={assistantIcon} alt="" class="h-5 w-5 object-contain" draggable="false" />
          {:else}
            <AssistantIcon size={20} />
          {/if}
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-sm font-semibold tracking-tight text-foreground">
            {assistant.name}
          </h1>
          <!--
            One fact per line. The clock is the assistant's identity here (how it
            runs), so the head states it alone and the All tab owns the run
            history: the old line glued both together and truncated the very
            time it was there to state.
          -->
          <p class="mt-0.5 truncate text-[0.6875rem] text-muted" title={scheduleLabel}>
            {scheduleLabel}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <!--
            The state is the pause control, and it wears the app's canonical
            status pill rather than a hand-coloured tag: a paused assistant is a
            warning, a running one a success, and the dot says which at a glance.
          -->
          <button
            type="button"
            class="flex shrink-0 items-center bg-transparent p-0 transition-opacity hover:opacity-80"
            title={assistant.paused ? 'Resume this assistant' : 'Pause this assistant'}
            aria-label={assistant.paused ? 'Resume this assistant' : 'Pause this assistant'}
            onclick={() => void togglePaused()}
          >
            <StatusPill tone={assistant.paused ? 'warning' : 'success'} dot>
              {assistant.paused ? 'Paused' : 'Running'}
            </StatusPill>
          </button>
          {#if !fullscreen}
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
              title="Open in full screen"
              aria-label="Open in full screen"
              onclick={() => (fullscreen = true)}
            >
              <CioMaximize size={13} strokeWidth={1.8} />
            </button>
          {/if}
        </div>
      </div>
      {#if assistant.description?.trim()}
        <p class="border-l border-border pl-2.5 text-[0.75rem] leading-relaxed text-muted">
          {assistant.description}
        </p>
      {/if}
    </header>
  {/if}
{/snippet}

{#snippet panelHeader()}
  <!--
    The app's own section strip (notification and memory panels draw the same
    one): text-xs, a 2px rule under the active label, and a count as plain
    tabular numerals rather than a second bordered box inside every tab. It
    wraps instead of scrolling sideways, so a panel narrower than its eight
    sections still shows Schedule, Wakes and Reporting rather than hiding the
    last three behind an invisible horizontal scroll.
  -->
  <div
    class="flex shrink-0 flex-wrap items-center gap-x-1 border-b border-border px-2"
    role="tablist"
    aria-label="Assistant sections"
  >
    {#each visibleTabs as entry (entry.id)}
      {@const count = tabCount(entry.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === entry.id}
        class="-mb-px flex items-center gap-1.5 border-b-2 px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors {activeTab ===
        entry.id
          ? 'border-foreground text-foreground'
          : 'border-transparent text-muted hover:text-foreground'}"
        title={entry.label}
        onclick={() => (panelTab = entry.id)}
      >
        {entry.label}
        {#if count !== null}
          <span class="tabular-nums {entry.id === 'issues' ? 'text-missed' : 'text-dimmed'}">
            {count}
          </span>
        {/if}
      </button>
    {/each}
  </div>
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

{#snippet panelContent()}
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if activeTab === 'all'}
      {#if assistant}
        <AssistantOverviewTab
          {scheduled}
          {lastRunLabel}
          {lastSuccessLabel}
          {nextRunLabel}
          {running}
          {knowledgeComplete}
          {sectionCount}
          {scheduleLabel}
          {wakes}
          connectionCount={connectionViews.length}
          {connectionProblems}
          {agentsComplete}
          {agentCount}
          {reportingBrief}
          {deliveryReady}
          missedCount={missedRuns.length}
          runIssueCount={runIssues.length}
          onRunNow={() => void runNow()}
          onSelect={(tab) => (panelTab = tab)}
        />
      {:else}
        {@render noAssistantState()}
      {/if}
    {:else if activeTab === 'behaviour'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <AssistantBehaviourTab
          {assistant}
          {knowledgeThread}
          checkpoint={gettingStartedCheckpoint}
          onOpenKnowledgeThread={openKnowledgeTask}
          onSave={saveSection}
        />
      {/if}
    {:else if activeTab === 'schedule'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <AssistantScheduleTab
          {assistant}
          {scheduled}
          {scheduleAgreed}
          {scheduleLabel}
          {nextRunLabel}
          {nextRunRelative}
          {missedRunPolicyLabel}
          hasKnowledgeThread={knowledgeThread !== null}
          onOpenKnowledgeThread={openKnowledgeTask}
          onPersist={persistAssistant}
        />
      {/if}
    {:else if activeTab === 'reporting'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <AssistantReportingTab {assistant} {deliveryReady} onPersist={persistAssistant} />
      {/if}
    {:else if activeTab === 'wakes'}
      {#if !assistant}
        {@render noAssistantState()}
      {:else}
        <div class="flex flex-col gap-2 p-3">
          <!-- The wakes an assistant's threads have armed on themselves. A wake
               belongs to a thread, so the section resolves the assistant's own
               threads first and then asks the app which of them are armed. -->
          <AssistantWakesSection {assistant} onOpenThread={onOpenTask} />
          {#if wakes.length === 0}
            <div class="flex flex-col gap-1.5 border border-border bg-surface p-2.5">
              <p class="text-[0.8125rem] font-semibold text-foreground">No wake is armed</p>
              <p class="text-[0.6875rem] leading-relaxed text-muted">
                A thread arms one itself when it has to wait for an answer, so it can pick the work
                up again without you watching it. They appear here to hold or stop.
              </p>
            </div>
          {/if}
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
      <AssistantIssuesTab
        {scheduled}
        {missedRuns}
        {runIssues}
        {backgroundRuns}
        {onOpenTask}
        onDismissMissed={(id) => void dismissRun(id)}
        onRunMissedNow={(run) => void runMissedNow(run)}
      />
    {/if}
  </div>
{/snippet}

{#snippet knowledgeThreadAction()}
  {#if assistant && knowledgeThread}
    <!--
      The Getting started thread is pinned for life and has exactly two states.
      Hide puts its row away for the session and Show brings it back; Modify
      behavior always lands in the thread itself, revealing it first when it was
      hidden, so the panel is never a dead end when the user wants to change what
      the assistant knows. Hide reads left, the action that opens the thread
      right, the way every footer in the app splits a falsy from a truthy action.
    -->
    <div class="flex shrink-0 items-center gap-2 border-t border-border px-3 py-1.5">
      <button
        type="button"
        class="flex min-w-0 items-center gap-1.5 text-left text-[0.625rem] text-muted transition-colors hover:text-foreground disabled:opacity-50"
        title={knowledgeThreadHidden
          ? 'Show the Getting started thread in the sidebar again'
          : 'Hide the Getting started thread from the sidebar'}
        disabled={knowledgeThreadBusy}
        onclick={() => void toggleKnowledgeThread()}
      >
        <AssistantIcon mark="knowledge" size={14} class="shrink-0" />
        <span class="truncate">
          {knowledgeThreadHidden ? 'Show getting started' : 'Hide getting started'}
        </span>
      </button>
      <button
        type="button"
        class="ml-auto flex min-w-0 items-center gap-1.5 text-left text-[0.625rem] text-muted transition-colors hover:text-foreground disabled:opacity-50"
        title="Open the Getting started thread to change what this assistant knows and does"
        disabled={knowledgeThreadBusy}
        onclick={openKnowledgeTask}
      >
        <CioPencil size={14} strokeWidth={1.8} class="shrink-0" />
        <span class="truncate">Modify behavior</span>
      </button>
    </div>
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
    the browser, terminal and pull request reader. The panel's own tabs are the
    strip's tabs, which is why this surface passes neither `onNew` nor `onCloseTab`:
    a section is switched, not opened or closed.
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
