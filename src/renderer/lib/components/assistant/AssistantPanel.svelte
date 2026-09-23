<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    Ban,
    ChevronRight,
    Gauge,
    Maximize2,
    Minimize2,
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
  import Modal from '$lib/components/ui/Modal.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { assistantRoutines } from '$lib/stores/assistant-routines.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
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
    type Thread,
    type UtilityCatalog
  } from '$shared/types'
  import {
    parseHowToSections,
    resolveConnections,
    serializeHowToSections,
    type HowToSection
  } from './assistant-view'
  import ConnectionRow from './ConnectionRow.svelte'
  import RoutineAgentPicker from './RoutineAgentPicker.svelte'
  import UtilityPicker from './UtilityPicker.svelte'
  import { buildConnectionLibrary, type ConnectionLibraryEntry } from './connection-library'

  interface Props {
    projectId: string
    threadId: string
    /** Routine snapshot from the tab; the task's own routineId wins when set. */
    routineId: string | null
    navigate: (view: MainView) => void
    /** Open one of the routine's tasks, so the workspace owns the selection. */
    onOpenTask: (task: Thread) => void
  }

  let { projectId, threadId, routineId, navigate, onOpenTask }: Props = $props()

  type PanelTab = 'all' | 'routine' | 'connections' | 'agents' | 'issues'

  const TABS: ReadonlyArray<{ id: PanelTab; label: string }> = [
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
    const id = task?.routineId ?? routineId
    if (!id) return null
    return assistantRoutines.routines.find((candidate) => candidate.id === id) ?? null
  })

  let catalog = $state<UtilityCatalog | null>(null)
  // The Utilities page shows the registry and the capabilities a harness discovers
  // side by side. Loading only the registry here made the picker look half empty.
  let capabilities = $state<AgentCapabilityCatalog | null>(null)
  // One-time load, matching how UtilitiesView fetches the same two catalogs.
  onMount(() => {
    void Promise.all([invoke('utilities:list'), invoke('capabilities:listAll')])
      .then(([utilityCatalog, capabilityCatalog]) => {
        catalog = utilityCatalog
        capabilities = capabilityCatalog
      })
      .catch(() => undefined)
  })

  /** Every connection the app can offer, registry and harness-discovered alike. */
  const connectionLibrary = $derived(buildConnectionLibrary(catalog, capabilities))

  // ─── Tabs ─────────────────────────────────────────────────────────────────

  let tab = $state<PanelTab>('all')
  let fullscreen = $state(false)

  const visibleTabs = $derived(
    routine ? TABS : TABS.filter((entry) => entry.id === 'all' || entry.id === 'issues')
  )
  const activeTab = $derived(
    visibleTabs.some((entry) => entry.id === tab) ? tab : ('all' as PanelTab)
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

  function addConnection(entry: ConnectionLibraryEntry): void {
    if (!routine) return
    const connections: RoutineConnection[] = [
      ...routine.connections,
      { utilityId: entry.id, label: entry.name, kind: entry.kind }
    ]
    void persistRoutine({ connections }, 'Could not add the connection')
  }

  function removeConnection(connection: RoutineConnection): void {
    if (!routine) return
    const connections = routine.connections.filter(
      (candidate) => candidate.utilityId !== connection.utilityId
    )
    void persistRoutine({ connections }, 'Could not remove the connection')
  }

  function openUtilities(): void {
    navigate('settings-utilities')
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  const routineTasks = $derived.by((): Thread[] => {
    if (!routine) return task ? [task] : []
    return scopeState.allScopeThreads.filter((thread) => thread.routineId === routine.id)
  })

  const missedRuns = $derived(
    routine ? assistantRoutines.missedForRoutine(routine.id) : assistantRoutines.missedForTask(threadId)
  )

  /** Task-level run problems: rate limits, failures, and interrupted runs. */
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
        issues.push({ id: `${entry.id}:failed`, task: entry, kind: 'Failed', detail: 'The last run failed' })
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

  // ─── Run history ──────────────────────────────────────────────────────────

  /** The run panel is routine-scoped; a routine-less task reports on itself. */
  const runScopeTasks = $derived(routine ? routineTasks : task ? [task] : [])

  const lastRunAt = $derived(
    runScopeTasks.reduce((latest, entry) => Math.max(latest, entry.lastRunAt ?? 0), 0)
  )
  const lastSuccessAt = $derived(
    runScopeTasks.reduce((latest, entry) => Math.max(latest, entry.lastSuccessAt ?? 0), 0)
  )
  const lastRunLabel = $derived(
    lastRunAt > 0 ? describeRelativeTime(lastRunAt, Date.now()) : 'never'
  )
  const lastSuccessLabel = $derived(
    lastSuccessAt > 0 ? describeRelativeTime(lastSuccessAt, Date.now()) : 'never'
  )

  let running = $state(false)

  /**
   * Run the routine immediately, ignoring its schedule and pause state, so the
   * user can test what they built without waiting for the next fire.
   */
  async function runRoutineNow(): Promise<void> {
    if (!routine || running) return
    running = true
    try {
      const count = await assistantRoutines.runRoutineNow(routine.id)
      toast.success(count === 1 ? 'Run started' : `${count} runs started`)
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
      await assistantRoutines.runMissedRunNow(run.id)
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

{#snippet panelHeader(isFullscreen: boolean)}
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
          onclick={() => (tab = entry.id)}
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
      title={isFullscreen ? 'Exit full screen' : 'Open in full screen'}
      aria-label={isFullscreen ? 'Exit full screen' : 'Open in full screen'}
      onclick={() => (fullscreen = !isFullscreen)}
    >
      {#if isFullscreen}
        <Minimize2 size={13} strokeWidth={1.8} />
      {:else}
        <Maximize2 size={13} strokeWidth={1.8} />
      {/if}
    </button>
  </div>
{/snippet}

{#snippet summaryRow(args: { title: string; detail: string; target: PanelTab; warn?: boolean })}
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
      onclick={() => (tab = args.target)}
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
              : 'No model picked yet. Choose a primary and two fallbacks.',
            target: 'agents',
            warn: !agentsComplete
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
          <p class="mb-1 text-[0.625rem] text-dimmed" title="Set by the agent from your prompt">
            Schedule: {describeSchedule(routine.schedule)}
          </p>
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
                  <RichMarkdownEditor
                    id="assistant-section-{section.id}"
                    value={editDraft}
                    onValueChange={(value) => (editDraft = value)}
                    placeholder="Write this section in Markdown…"
                    ariaLabel="Edit {section.title}"
                    autofocus
                    containerClass="rounded-md border border-border bg-surface"
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
              <ConnectionRow {view} onRemove={removeConnection} onOpenUtilities={openUtilities} />
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
                    Was due {new Date(run.dueAt).toLocaleString()} while the app was closed.
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

{#if !fullscreen}
  <div class="flex h-full min-h-0 flex-col" aria-label="Assistant routine panel">
    {@render panelHeader(false)}
    {@render panelContent()}
  </div>
{/if}

<Modal
  open={fullscreen}
  title="Assistant routine"
  placement="fullscreen"
  chrome={false}
  panelClass="bg-app"
  onClose={() => (fullscreen = false)}
>
  <div class="flex h-full min-h-0 flex-col">
    {@render panelHeader(true)}
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
      {@render panelContent()}
    </div>
  </div>
</Modal>
