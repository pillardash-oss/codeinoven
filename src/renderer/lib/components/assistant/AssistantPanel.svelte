<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    Ban,
    ChevronRight,
    Gauge,
    Hammer,
    Maximize2,
    Pause,
    Pencil,
    Play,
    RotateCcw,
    ScrollText,
    Workflow
  } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { toast } from 'svelte-sonner'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import EnumSelect from '$lib/components/ui/EnumSelect.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import type { AssistantPanelTab } from '$lib/stores/context-sidebar-types'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { formatDateTime } from '$shared/date-time-format'
  import {
    describeRelativeTime,
    describeSchedule,
    routineAgentsComplete,
    routineHowToComplete,
    type AgentCapabilityCatalog,
    type MissedRun,
    type Routine,
    type RoutineAgents,
    type RoutineConnection,
    type RoutineDeliveryChannel,
    type RoutineImpact,
    type RoutineTimeliness,
    type Thread,
    type UtilityCatalog
  } from '$shared/types'
  import {
    isExternalDeliveryChannel,
    routineDeliveryChannelLabel,
    routineDeliveryLabel,
    routinePriorityLabel,
    ROUTINE_DELIVERY_OPTIONS,
    ROUTINE_IMPACT_OPTIONS,
    ROUTINE_TIMELINESS_OPTIONS
  } from '$shared/routine-reporting'
  import {
    parseHowToSections,
    resolveConnections,
    serializeHowToSections,
    missedRunReasonText,
    type ConnectionView,
    type HowToSection
  } from './assistant-view'
  import {
    buildConnectionLibrary,
    connectionNamesOverlap,
    type ConnectionLibraryEntry
  } from './connection-library'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import ConnectionRow from './ConnectionRow.svelte'
  import RoutineAgentPicker from './RoutineAgentPicker.svelte'
  import UtilityPicker from './UtilityPicker.svelte'
  import UtilityEditorModal, {
    type UtilityEditorTarget
  } from '$lib/components/settings/UtilityEditorModal.svelte'

  interface Props {
    projectId: string
    threadId: string
    /** Routine snapshot from the tab; the task's own routineId wins when set. */
    routineId: string | null
    /** The section on screen. It is bound to the sidebar tab (not local state)
     *  so switching to another sidebar panel and back reopens the same section
     *  instead of resetting the panel to "All". */
    panelTab: AssistantPanelTab
    navigate: (view: MainView) => void
    /** Open one of the routine's tasks, so the workspace owns the selection. */
    onOpenTask: (task: Thread) => void
  }

  let {
    projectId,
    threadId,
    routineId,
    panelTab = $bindable(),
    navigate,
    onOpenTask
  }: Props = $props()

  const TABS: ReadonlyArray<{ id: AssistantPanelTab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'routine', label: 'Routine' },
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

  const routine = $derived.by((): Routine | null => {
    // The panel's own routine id is authoritative: one panel per routine means
    // selecting another task must never re-target this panel (its anchor task
    // can even belong to a different routine, e.g. a routine with no tasks yet).
    // The task's routine is only a fallback for a panel opened without one.
    const id = routineId ?? task?.routineId
    if (!id) return null
    return assistantRoutines.routines.find((candidate) => candidate.id === id) ?? null
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
    routine ? TABS : TABS.filter((entry) => entry.id === 'all' || entry.id === 'issues')
  )
  const activeTab = $derived(
    visibleTabs.some((entry) => entry.id === panelTab) ? panelTab : ('all' as AssistantPanelTab)
  )

  // ─── Routine content ──────────────────────────────────────────────────────

  const sections = $derived(routine ? parseHowToSections(routine.howTo) : [])
  const howToComplete = $derived(routine ? routineHowToComplete(routine) : false)
  const agentsComplete = $derived(routine ? routineAgentsComplete(routine) : false)

  const collapsed = new SvelteSet<string>()
  let editingId = $state<string | null>(null)
  let editDraft = $state('')

  function toggleSection(id: string): void {
    if (collapsed.has(id)) collapsed.delete(id)
    else collapsed.add(id)
  }

  function startEdit(section: HowToSection): void {
    editingId = section.id
    editDraft = section.body
    collapsed.delete(section.id)
  }

  function cancelEdit(): void {
    editingId = null
    editDraft = ''
  }

  async function saveSection(sectionId: string): Promise<void> {
    if (!routine) return
    const next = sections.map((section) =>
      section.id === sectionId ? { ...section, body: editDraft.trim() } : section
    )
    editingId = null
    await persistRoutine({ howTo: serializeHowToSections(next) }, 'Could not save the how-to')
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  async function persistRoutine(
    patch: Parameters<typeof assistantRoutines.updateRoutine>[1],
    failureMessage: string
  ): Promise<void> {
    if (!routine) return
    try {
      await assistantRoutines.updateRoutine(routine.id, patch)
    } catch (error) {
      reportError(error, failureMessage)
    }
  }

  async function togglePaused(): Promise<void> {
    if (!routine) return
    await persistRoutine(
      { paused: !routine.paused },
      routine.paused ? 'Could not resume the routine' : 'Could not pause the routine'
    )
  }

  function setAgents(agents: RoutineAgents): void {
    void persistRoutine({ agents }, 'Could not save the routine models')
  }

  // ─── Reporting: where the output goes, and how urgent it is ────────────────

  /** The delivery channels, with a hint saying whether the choice needs a connection. */
  const deliveryChoices = ROUTINE_DELIVERY_OPTIONS.map((option) => ({
    id: option.id,
    label: option.label,
    hint: option.external
      ? 'Needs a connection this routine must have'
      : 'A normal thread notification inside CodeInOven'
  }))

  /**
   * Pick the delivery channel. The destination and any note are carried over, so
   * switching channel does not silently discard what the user already told the
   * agent; the in-app channel drops the destination because it has none.
   */
  function setDeliveryChannel(channel: RoutineDeliveryChannel): void {
    if (!routine) return
    const current = routine.delivery
    const target = current?.target?.trim()
    void persistRoutine(
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
    if (!routine) return
    const delivery = routine.delivery
    if (!delivery || delivery.channel === 'in-app') return
    const target = raw.trim()
    if (target === (delivery.target ?? '')) return
    void persistRoutine(
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
    void persistRoutine({ delivery: null }, 'Could not clear the delivery channel')
  }

  /**
   * Set one priority bracket, keeping the other. When the routine has no
   * priority yet the other bracket starts from the middle of its scale, and the
   * panel immediately shows the pair that was actually saved.
   */
  function setPriorityTimeliness(timeliness: RoutineTimeliness): void {
    if (!routine) return
    void persistRoutine(
      { priority: { timeliness, impact: routine.priority?.impact ?? 'team' } },
      'Could not save the priority'
    )
  }

  function setPriorityImpact(impact: RoutineImpact): void {
    if (!routine) return
    void persistRoutine(
      { priority: { timeliness: routine.priority?.timeliness ?? 'today', impact } },
      'Could not save the priority'
    )
  }

  function clearPriority(): void {
    void persistRoutine({ priority: null }, 'Could not clear the priority')
  }

  const connectionViews = $derived(
    resolveConnections(routine?.connections ?? [], catalog, capabilities)
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
    const delivery = routine?.delivery
    if (!delivery || !isExternalDeliveryChannel(delivery.channel)) return true
    const channel = routineDeliveryChannelLabel(delivery.channel)
    return connectionViews.some(
      (view) => view.status === 'ready' && connectionNamesOverlap(view.connection.label, channel)
    )
  })

  /** The reporting half of the routine as one line, for the All tab's brief. */
  const reportingBrief = $derived.by(() => {
    if (!routine) return 'Nothing agreed yet.'
    const parts: string[] = []
    if (routine.delivery) parts.push(routineDeliveryLabel(routine.delivery))
    if (routine.priority) parts.push(routinePriorityLabel(routine.priority))
    if (parts.length === 0) return 'Nothing agreed yet. Ask the agent, or set it here.'
    return parts.join(' \u00b7 ')
  })

  function addConnection(entry: ConnectionLibraryEntry): void {
    if (!routine) return
    const connections: RoutineConnection[] = [
      ...routine.connections,
      { utilityId: entry.id, label: entry.name, kind: entry.kind }
    ]
    void persistRoutine({ connections }, 'Could not add the connection')
  }

  /**
   * Removing a connection is destructive, so the row's X only stages it and the
   * shared confirmation dialog commits it. The trigger is a small icon, so a
   * stray click must never drop a connection the routine depends on.
   */
  let connectionRemoveTarget = $state<RoutineConnection | null>(null)
  let connectionRemoveBusy = $state(false)

  function removeConnection(connection: RoutineConnection): void {
    if (!routine) return
    connectionRemoveTarget = connection
  }

  async function confirmRemoveConnection(): Promise<void> {
    const connection = connectionRemoveTarget
    if (!routine || !connection) return
    connectionRemoveBusy = true
    try {
      const connections = routine.connections.filter(
        (candidate) => candidate.utilityId !== connection.utilityId
      )
      await persistRoutine({ connections }, 'Could not remove the connection')
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
  let connectionSetupSeed = $state('')

  function openConnectionSetup(view: ConnectionView): void {
    connectionSetupSeed = view.connection.setup ?? ''
    if (view.entry?.utility) {
      connectionSetupTarget = { kind: 'registry', utility: view.entry.utility }
    } else if (view.entry?.capability) {
      connectionSetupTarget = { kind: 'native', entry: view.entry.capability }
    } else {
      connectionSetupTarget = null
    }
    connectionSetupOpen = true
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  /**
   * Every thread this panel reports on. A run inherits its task's `routineId`,
   * so the routine's runs are in here too: the execution status of a run
   * (working, failed, interrupted) lives on the run thread, not the task.
   */
  const routineTasks = $derived.by((): Thread[] => {
    if (!routine) return task ? [task] : []
    return scopeState.allScopeThreads.filter((thread) => thread.routineId === routine.id)
  })

  const missedRuns = $derived(
    routine
      ? assistantRoutines.missedForRoutine(routine.id)
      : assistantRoutines.missedForTask(threadId)
  )

  /** Run problems: rate limits, failures, and interrupted runs. Each entry is a
   *  thread   usually one run, since that is where the execution status lives. */
  const runIssues = $derived.by(() => {
    const issues: Array<{ id: string; task: Thread; kind: string; detail: string }> = []
    for (const entry of routineTasks) {
      const retryAt = agentRuns.retryAt(entry.projectId, entry.id)
      if (retryAt !== null) {
        issues.push({
          id: `${entry.id}:limit`,
          task: entry,
          kind: 'Rate limited',
          detail: `Retrying ${describeRelativeTime(retryAt, Date.now())}`
        })
      }
      if (entry.status === 'failed') {
        issues.push({
          id: `${entry.id}:failed`,
          task: entry,
          kind: 'Failed',
          detail: 'The last run failed'
        })
      } else if (entry.status === 'interrupted') {
        issues.push({
          id: `${entry.id}:interrupted`,
          task: entry,
          kind: 'Interrupted',
          detail: 'The last run was interrupted'
        })
      }
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

  /** The run panel is routine-scoped; a routine-less task reports on itself. */
  const runScopeTasks = $derived(routine ? routineTasks : task ? [task] : [])

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

  let running = $state(false)

  // ─── The routine's how-to thread ──────────────────────────────────────────

  /**
   * The routine's how-to ("Getting started") thread, hidden or not. A hidden
   * row never reaches the hydrated thread list the sidebar renders from, so the
   * panel asks the main process for its own routine's thread instead of reading
   * the workspace's rows.
   */
  let howToThread = $state<Thread | null>(null)
  let howToThreadBusy = $state(false)

  $effect(() => {
    const routineIdValue = routine?.id ?? null
    if (!routineIdValue) {
      howToThread = null
      return
    }
    // The same target drives the interview checkpoint: the panel is looking at
    // this routine's how-to, so the state its authoring conversation agreed is
    // worth having loaded (and the store keeps it fresh from then on).
    void assistantRoutines.refreshCheckpoint(routineIdValue)
    let cancelled = false
    void assistantRoutines
      .howToThread(routineIdValue)
      .then((thread) => {
        if (!cancelled) howToThread = thread
      })
      .catch(() => {
        if (!cancelled) howToThread = null
      })
    return () => {
      cancelled = true
    }
  })

  const howToThreadHidden = $derived(howToThread?.archived === true)

  /**
   * What this routine's Getting started conversation has agreed so far, as the
   * agent recorded it. The store keeps it current: it loads one when the panel
   * targets a routine and refreshes it on `routine:checkpointChanged`, so this
   * is a plain read.
   */
  const gettingStartedCheckpoint = $derived(
    routine ? (assistantRoutines.checkpoints.get(routine.id) ?? null) : null
  )

  /**
   * Hide or reveal the how-to thread. It stays pinned either way, so this is
   * the thread's only state change, and revealing also opens the authoring
   * thread so the user lands where the how-to is written.
   */
  async function toggleHowToThread(): Promise<void> {
    if (!routine || !howToThread || howToThreadBusy) return
    const revealing = howToThreadHidden
    howToThreadBusy = true
    try {
      const updated = await assistantRoutines.setHowToHidden(routine.id, !revealing)
      howToThread = updated
      if (revealing) onOpenTask(updated)
    } catch (error) {
      reportError(
        error,
        revealing ? 'Could not show the how-to thread' : 'Could not hide the how-to thread'
      )
    } finally {
      howToThreadBusy = false
    }
  }

  /**
   * Run the routine immediately, ignoring its schedule and pause state, so the
   * user can test what they built without waiting for the next fire. Every task
   * runs on a fresh thread, so the first run is opened to show it happening.
   */
  async function runRoutineNow(): Promise<void> {
    if (!routine || running) return
    running = true
    try {
      const runs = await assistantRoutines.runRoutineNow(routine.id)
      toast.success(runs.length === 1 ? 'Run started' : `${runs.length} runs started`)
      const first = runs[0]
      if (first) onOpenTask(first)
    } catch (error) {
      reportError(error, 'Could not run the routine')
    } finally {
      running = false
    }
  }

  async function dismissRun(id: string): Promise<void> {
    try {
      await assistantRoutines.dismissMissedRun(id)
    } catch (error) {
      reportError(error, 'Could not dismiss the missed run')
    }
  }

  async function runNow(run: MissedRun): Promise<void> {
    try {
      const created = await assistantRoutines.runMissedRunNow(run.id)
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
          {#if entry.id === 'issues' && issueCount > 0}
            <span
              class="tabular-nums rounded-full px-1 text-[0.5625rem]"
              style="color: var(--color-missed); background: color-mix(in srgb, var(--color-missed) 16%, transparent)"
            >
              {issueCount}
            </span>
          {/if}
          {#if activeTab === entry.id}
            <span class="absolute inset-x-1.5 bottom-0 h-[2px] rounded-full bg-primary"></span>
          {/if}
        </button>
      {/each}
    </div>
    <button
      type="button"
      class="my-1 flex w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Open in full screen"
      aria-label="Open in full screen"
      onclick={() => (fullscreen = true)}
    >
      <Maximize2 size={13} strokeWidth={1.8} />
    </button>
  </div>
{/snippet}

{#snippet summaryRow(args: {
  title: string
  detail: string
  target: AssistantPanelTab
  warn?: boolean
})}
  <div class="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2">
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-1.5">
        <span class="text-[0.75rem] text-foreground">{args.title}</span>
        {#if args.warn}
          <span
            class="flex items-center"
            style="color: var(--color-warning)"
            role="img"
            aria-label="{args.title} needs setup"
            title="{args.title} needs setup"
          >
            <AlertTriangle size={11} strokeWidth={2} />
          </span>
        {/if}
      </div>
      <p class="mt-0.5 text-[0.625rem] leading-relaxed text-dimmed">{args.detail}</p>
    </div>
    <button
      type="button"
      class="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Open {args.title}"
      aria-label="Open {args.title}"
      onclick={() => (panelTab = args.target)}
    >
      More
      <ChevronRight size={12} strokeWidth={1.8} />
    </button>
  </div>
{/snippet}

{#snippet routineEmptyState()}
  <div class="flex flex-col items-center gap-2.5 px-4 py-9 text-center">
    <span
      class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-elevated"
    >
      <ScrollText size={17} strokeWidth={1.6} class="text-dimmed" />
    </span>
    <p class="text-[0.8125rem] font-medium text-foreground">No how-to yet</p>
    <p class="max-w-[17rem] text-[0.75rem] leading-relaxed text-muted">
      Describe what this routine should do to the agent in its task. Tell it the goal, the steps,
      and when it should run. The plan you agree on shows up here.
    </p>
  </div>
  {#if gettingStartedCheckpoint}
    <div class="px-3 pb-3">
      <div class="rounded-lg border border-border bg-elevated p-2.5">
        <p class="mb-1 text-[0.6875rem] font-medium text-foreground">Agreed so far</p>
        <p class="mb-1.5 text-[0.625rem] leading-relaxed text-dimmed">
          What you and the agent have agreed for this routine so far.
        </p>
        <div class="text-[0.6875rem] text-muted">
          <MarkdownView text={gettingStartedCheckpoint} class="markdown-body-card" />
        </div>
      </div>
    </div>
  {/if}
{/snippet}

{#snippet noRoutineState()}
  <div class="flex flex-col items-center gap-2.5 px-4 py-9 text-center">
    <span
      class="flex h-10 w-10 items-center justify-center rounded-full border border-border bg-elevated"
    >
      <Workflow size={17} strokeWidth={1.6} class="text-dimmed" />
    </span>
    <p class="text-[0.8125rem] font-medium text-foreground">Not part of a routine</p>
    <p class="max-w-[17rem] text-[0.75rem] leading-relaxed text-muted">
      Group this task into a routine to give it instructions, connections, models, and a schedule.
    </p>
  </div>
{/snippet}

{#snippet panelContent()}
  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if activeTab === 'all'}
      <div class="flex flex-col gap-2 p-3">
        {#if routine}
          <button
            type="button"
            class="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-[0.75rem] transition-colors hover:bg-elevated"
            title={routine.paused ? 'Resume this routine' : 'Pause this routine'}
            aria-label={routine.paused ? 'Resume this routine' : 'Pause this routine'}
            onclick={() => void togglePaused()}
          >
            {#if routine.paused}
              <Play size={13} strokeWidth={1.8} class="text-muted" />
              <span class="min-w-0 flex-1 text-foreground">Resume routine</span>
              <span class="text-[0.625rem]" style="color: var(--color-warning)">Paused</span>
            {:else}
              <Pause size={13} strokeWidth={1.8} class="text-muted" />
              <span class="min-w-0 flex-1 text-foreground">Pause routine</span>
              <span class="text-[0.625rem] text-dimmed">Running</span>
            {/if}
          </button>

          <div class="flex flex-col gap-2 rounded-lg border border-border px-2.5 py-2">
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                title="Run this routine now, even while paused"
                aria-label="Run this routine now"
                disabled={running || !howToComplete}
                onclick={() => void runRoutineNow()}
              >
                <RotateCcw size={12} strokeWidth={1.8} class={running ? 'animate-spin' : ''} />
                Run now
              </button>
              <span class="min-w-0 flex-1 text-[0.625rem] leading-relaxed text-dimmed">
                {howToComplete
                  ? 'Test it without waiting for the schedule.'
                  : 'Save a how-to first.'}
              </span>
            </div>
            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.625rem] text-dimmed">
              <span title="The last time a run was dispatched">Last run: {lastRunLabel}</span>
              <span title="The last time a run finished successfully">
                Last success: {lastSuccessLabel}
              </span>
            </div>
          </div>

          {@render summaryRow({
            title: 'Routine',
            detail: howToComplete
              ? `${sections.length} section${sections.length === 1 ? '' : 's'} · ${describeSchedule(routine.schedule)}`
              : 'No how-to yet. Describe the routine to the agent in its task.',
            target: 'routine',
            warn: !howToComplete
          })}

          {@render summaryRow({
            title: 'Connections',
            detail:
              connectionViews.length === 0
                ? 'No connections yet.'
                : connectionProblems === 0
                  ? `${connectionViews.length} connected and ready.`
                  : `${connectionProblems} of ${connectionViews.length} need setup.`,
            target: 'connections',
            warn: connectionProblems > 0
          })}

          {@render summaryRow({
            title: 'Agents',
            detail: agentsComplete
              ? `${1 + (routine.agents?.fallbacks.length ?? 0)} models: a primary and its fallbacks.`
              : 'No model set. Add a primary and fallbacks on the Agents tab.',
            target: 'agents',
            warn: !agentsComplete
          })}

          {@render summaryRow({
            title: 'Reporting',
            detail: reportingBrief,
            target: 'routine',
            warn: !deliveryReady
          })}

          {@render summaryRow({
            title: 'Issues',
            detail:
              issueCount === 0
                ? 'Nothing needs attention.'
                : `${missedRuns.length} missed · ${runIssues.length} run issue${runIssues.length === 1 ? '' : 's'}.`,
            target: 'issues',
            warn: issueCount > 0
          })}
        {:else}
          {@render noRoutineState()}
        {/if}
      </div>
    {:else if activeTab === 'routine'}
      {#if !routine}
        {@render noRoutineState()}
      {:else if !howToComplete}
        {@render routineEmptyState()}
      {:else}
        <div class="flex flex-col gap-1.5 p-3">
          {#if routine.description?.trim()}
            <p
              class="mb-1 rounded-lg bg-elevated px-2.5 py-2 text-[0.6875rem] leading-relaxed text-muted"
              title="Your own note about this routine, never sent to the agent"
            >
              {routine.description}
            </p>
          {/if}
          <p class="mb-1 text-[0.625rem] text-dimmed" title="Set by the agent from your prompt">
            Schedule: {describeSchedule(routine.schedule)}
          </p>

          <div class="mb-1 flex flex-col gap-2 rounded-lg border border-border px-2.5 py-2">
            <div class="flex items-center gap-1.5">
              <span class="text-[0.75rem] text-foreground">Reporting</span>
              {#if !deliveryReady}
                <span
                  class="flex items-center"
                  style="color: var(--color-warning)"
                  role="img"
                  aria-label="The delivery channel needs a connection"
                  title="The delivery channel needs a connection"
                >
                  <AlertTriangle size={11} strokeWidth={2} />
                </span>
              {/if}
            </div>
            <p class="text-[0.625rem] leading-relaxed text-dimmed">
              Where this routine's output goes, and how urgent it is. Agree it with the agent, or
              set it here.
            </p>

            <div class="flex flex-col gap-1.5">
              <div class="flex items-center gap-1.5">
                <EnumSelect
                  options={deliveryChoices}
                  value={routine.delivery?.channel ?? null}
                  onChange={setDeliveryChannel}
                  placeholder="Delivery channel"
                  ariaLabel="Delivery channel"
                  title="Where this routine's output is delivered"
                  class="flex-1"
                />
                {#if routine.delivery}
                  <button
                    type="button"
                    class="shrink-0 rounded-md px-1.5 py-1 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                    title="Clear the delivery channel"
                    aria-label="Clear the delivery channel"
                    onclick={clearDelivery}
                  >
                    Clear
                  </button>
                {/if}
              </div>

              {#if routine.delivery && routine.delivery.channel !== 'in-app'}
                <input
                  type="text"
                  class="w-full rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-[0.75rem] text-foreground outline-none transition-colors placeholder:text-dimmed focus-visible:ring-2 focus-visible:ring-primary"
                  placeholder="Destination: a chat, a channel, an address"
                  aria-label="Delivery destination"
                  title="The concrete destination, for example #eng-alerts"
                  value={routine.delivery.target ?? ''}
                  onblur={(event) => commitDeliveryTarget(event.currentTarget.value)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                />
              {/if}

              {#if routine.delivery && !deliveryReady}
                <p class="text-[0.625rem] leading-relaxed" style="color: var(--color-warning)">
                  {routineDeliveryChannelLabel(routine.delivery.channel)} is not connected yet. Add it
                  on the Connections tab; until then runs deliver in CodeInOven.
                </p>
              {/if}
            </div>

            <div class="flex items-center gap-1.5">
              <EnumSelect
                options={ROUTINE_TIMELINESS_OPTIONS}
                value={routine.priority?.timeliness ?? null}
                onChange={setPriorityTimeliness}
                placeholder="Timeliness"
                ariaLabel="Time-based priority"
                title="How soon this routine's output matters"
                class="flex-1"
              />
              <EnumSelect
                options={ROUTINE_IMPACT_OPTIONS}
                value={routine.priority?.impact ?? null}
                onChange={setPriorityImpact}
                placeholder="Impact"
                ariaLabel="Scope-based priority"
                title="How far this routine's output reaches"
                class="flex-1"
              />
              {#if routine.priority}
                <button
                  type="button"
                  class="shrink-0 rounded-md px-1.5 py-1 text-[0.625rem] text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  title="Clear the priority"
                  aria-label="Clear the priority"
                  onclick={clearPriority}
                >
                  Clear
                </button>
              {/if}
            </div>
          </div>
          {#each sections as section (section.id)}
            {@const folded = collapsed.has(section.id) && editingId !== section.id}
            <div class="rounded-lg border border-border">
              <div class="flex items-center gap-1.5 px-2.5 py-1.5">
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-expanded={!folded}
                  title={folded ? `Expand ${section.title}` : `Fold ${section.title}`}
                  onclick={() => toggleSection(section.id)}
                >
                  <ChevronRight
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
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                    title="Edit {section.title}"
                    aria-label="Edit {section.title}"
                    onclick={() => startEdit(section)}
                  >
                    <Pencil size={12} strokeWidth={1.8} />
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
                    containerClass="rounded-md border border-border bg-surface"
                    class="min-h-10 w-full px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
                  />
                  <div class="mt-1.5 flex justify-end gap-1.5">
                    <button
                      type="button"
                      class="rounded-md px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      onclick={cancelEdit}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      class="rounded-md bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
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
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'connections'}
      {#if !routine}
        {@render noRoutineState()}
      {:else}
        <div class="flex flex-col gap-2 p-3">
          {#if connectionViews.length === 0}
            <p class="text-[0.6875rem] leading-relaxed text-dimmed">
              No connections yet. Add the tools this routine needs, or let the agent name them as it
              writes the how-to.
            </p>
          {:else}
            {#each connectionViews as view (view.connection.utilityId)}
              <ConnectionRow {view} onRemove={removeConnection} onSetup={openConnectionSetup} />
            {/each}
          {/if}
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
      {#if !routine}
        {@render noRoutineState()}
      {:else}
        <div class="p-3">
          {#key routine.id}
            <RoutineAgentPicker
              agents={routine.agents}
              {providers}
              projectId={projectIdForCatalog}
              onChange={setAgents}
            />
          {/key}
        </div>
      {/if}
    {:else}
      <div class="flex flex-col gap-3 p-3">
        <section aria-label="Missed runs">
          <h2 class="mb-1.5 text-[0.6875rem] font-medium text-muted">Missed runs</h2>
          {#if missedRuns.length === 0}
            <p class="text-[0.6875rem] text-dimmed">No scheduled run has been missed.</p>
          {:else}
            <div class="flex flex-col gap-1.5">
              {#each missedRuns as run (run.id)}
                <div class="rounded-lg border border-border p-2.5">
                  <div class="flex items-center gap-2">
                    <AlertTriangle size={13} strokeWidth={1.8} style="color: var(--color-missed)" />
                    <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                      {run.title}
                    </span>
                  </div>
                  <p class="mt-1 text-[0.625rem] text-dimmed">
                    Was due {formatDateTime(run.dueAt)}. {missedRunReasonText(run.reason)}
                  </p>
                  <div class="mt-2 flex justify-end gap-1.5">
                    <button
                      type="button"
                      class="rounded-md px-2 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      onclick={() => void dismissRun(run.id)}
                    >
                      Dismiss
                    </button>
                    <button
                      type="button"
                      class="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-[0.6875rem] text-on-primary transition-colors hover:bg-primary-hover"
                      onclick={() => void runNow(run)}
                    >
                      <RotateCcw size={12} strokeWidth={1.8} />
                      Run now
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section aria-label="Run issues">
          <h2 class="mb-1.5 text-[0.6875rem] font-medium text-muted">Run issues</h2>
          {#if runIssues.length === 0}
            <p class="text-[0.6875rem] text-dimmed">No rate limits, failures, or interruptions.</p>
          {:else}
            <div class="flex flex-col gap-1.5">
              {#each runIssues as issue (issue.id)}
                <button
                  type="button"
                  class="flex items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left transition-colors hover:bg-elevated"
                  title="Open {issue.task.title}"
                  aria-label="Open {issue.task.title}"
                  onclick={() => onOpenTask(issue.task)}
                >
                  <span class="mt-0.5 shrink-0" style="color: var(--color-warning)">
                    {#if issue.kind === 'Rate limited'}
                      <Gauge size={13} strokeWidth={1.8} />
                    {:else if issue.kind === 'Interrupted'}
                      <Ban size={13} strokeWidth={1.8} />
                    {:else}
                      <AlertTriangle size={13} strokeWidth={1.8} />
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
        </section>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet howToThreadAction()}
  {#if routine && howToThread}
    <!-- The how-to thread is pinned for life and has exactly two states. Hide
         puts it away for the session, Show brings it back and opens it, so the
         panel is always the way back to the routine's authoring thread. -->
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-1.5 text-left text-[0.625rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title={howToThreadHidden
        ? 'Show the routine’s how-to thread again'
        : 'Hide the routine’s how-to thread from the sidebar'}
      disabled={howToThreadBusy}
      onclick={() => void toggleHowToThread()}
    >
      <Hammer size={12} strokeWidth={1.8} class="shrink-0" />
      <span class="truncate">
        {howToThreadHidden ? 'Show how-to thread' : 'Hide how-to thread'}
      </span>
    </button>
  {/if}
{/snippet}

{#if !fullscreen}
  <div class="flex h-full min-h-0 flex-col" aria-label="Assistant routine panel">
    {@render panelHeader()}
    {@render panelContent()}
    {@render howToThreadAction()}
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
      {@render panelContent()}
    </div>
    {@render howToThreadAction()}
  </FullscreenPanelDialog>
{/if}

{#if connectionSetupOpen}
  <!--
    The same Add capability modal the Utilities page uses, opened from a
    connection that still needs setup. The agent-assisted step is prefilled
    with the prompt the authoring agent recorded, and the connection library is
    reloaded afterwards so an install flips the row to ready in place.
  -->
  <UtilityEditorModal
    open
    target={connectionSetupTarget}
    agentRequestSeed={connectionSetupSeed}
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
    Remove <strong class="text-foreground">{connectionRemoveTarget?.label ?? ''}</strong> from this routine?
    The agent will no longer use it when this routine runs.
  </p>
</ConfirmDialog>
