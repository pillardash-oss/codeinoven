<script module lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import type { TurnCheckpointFileDiff, TurnCheckpointSummary } from '$shared/types'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { LatestRequestGuard } from '$lib/refresh-guard'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'

  type ChangesMode = 'diffs' | 'files'

  /** Durable per-thread state that survives the panel's remount cycle. */
  interface DiffPanelCache {
    checkpoints: TurnCheckpointSummary[]
    selectedCheckpointId: string | null
    fileDiffsByCheckpoint: SvelteMap<string, TurnCheckpointFileDiff[]>
  }

  const panelCache = new SvelteMap<string, DiffPanelCache>()

  function cacheKeyFor(projectId: string, threadId: string): string {
    return `${projectId}:${threadId}`
  }

  function getOrCreateCache(projectId: string, threadId: string): DiffPanelCache {
    const key = cacheKeyFor(projectId, threadId)
    let entry = panelCache.get(key)
    if (!entry) {
      entry = {
        checkpoints: [],
        selectedCheckpointId: null,
        fileDiffsByCheckpoint: new SvelteMap()
      }
      panelCache.set(key, entry)
    }
    return entry
  }

  /**
   * Owns the panel's complete state for one mounted instance. The identity is
   * the `projectId:threadId` pair; switching identity re-seeds durable state
   * from the shared cache and resets every transient field, so the panel stays
   * correct when a parent reuses this instance across threads instead of keying
   * it. A generation counter invalidates any in-flight async work from a prior
   * identity so stale results can never overwrite the current thread.
   */
  export class DiffSidebarController {
    projectId = $state('')
    threadId = $state('')
    checkpoints = $state<TurnCheckpointSummary[]>([])
    /** The running turn's live change summary — absent once the turn completes. */
    liveTurn = $state<TurnCheckpointSummary | null>(null)
    liveRevision = $state(0)
    selectedCheckpointId = $state<string | null>(null)
    loading = $state(false)
    error = $state('')
    restoringId = $state<string | null>(null)
    selections = $state<Record<string, string[]>>({})
    mode = $state<ChangesMode>('diffs')
    fileDiffs = $state<TurnCheckpointFileDiff[]>([])
    loadingDiffs = $state(false)
    expandedDiffs = $state<Record<string, boolean>>({})
    flashPath = $state<string | null>(null)
    loadedDiffKey: string | null = null
    scrollContainer = $state<HTMLElement | null>(null)

    private refreshGuard = new LatestRequestGuard()
    private generation = 0
    private cache: DiffPanelCache | null = null
    private revealTarget: string | null = null
    private revealNonce = 0
    private preferredCheckpointId: string | null = null
    private pollTimer: ReturnType<typeof setInterval> | null = null
    private unsubscribeEvents: (() => void) | null = null

    constructor() {
      this.setIdentity('', '')
    }

    setIdentity(projectId: string, threadId: string): void {
      if (projectId === this.projectId && threadId === this.threadId) return
      this.generation += 1
      this.projectId = projectId
      this.threadId = threadId
      this.cache = getOrCreateCache(projectId, threadId)
      this.checkpoints = this.cache.checkpoints
      this.selectedCheckpointId = this.cache.selectedCheckpointId
      const cachedDiffs = this.cache.selectedCheckpointId
        ? (this.cache.fileDiffsByCheckpoint.get(this.cache.selectedCheckpointId) ?? null)
        : null
      this.fileDiffs = cachedDiffs ?? []
      this.loadedDiffKey = cachedDiffs ? this.cache.selectedCheckpointId : null
      this.liveTurn = null
      this.liveRevision = 0
      this.loading = false
      this.error = ''
      this.restoringId = null
      this.selections = {}
      this.mode = 'diffs'
      this.loadingDiffs = false
      this.expandedDiffs = {}
      this.flashPath = null
      this.revealTarget = null
      this.revealNonce = 0
      this.preferredCheckpointId = null
    }

    /** Runs on every prop update; no-ops unless the identity actually changed. */
    syncIdentity(projectId: string, threadId: string): string {
      this.setIdentity(projectId, threadId)
      return `${projectId}:${threadId}`
    }

    /** Adopts the parent-preferred checkpoint and pulls it into view when it changes. */
    syncPreferredCheckpoint(checkpointId: string | null): string | null {
      if (checkpointId === this.preferredCheckpointId) return checkpointId
      this.preferredCheckpointId = checkpointId
      if (checkpointId && this.projectId) void this.refresh(checkpointId)
      return checkpointId
    }

    /** Records the latest reveal request so the next diff render applies it. */
    requestReveal(path: string | null, nonce: number): string | null {
      if (!path || nonce <= 0) return null
      this.revealTarget = path
      this.revealNonce = nonce
      this.applyReveal()
      return path
    }

    private applyReveal(): void {
      const target = this.revealTarget
      if (!target || this.revealNonce <= 0) return
      if (!this.fileDiffs.some((diff) => diff.path === target)) return
      const el = this.scrollContainer?.querySelector<HTMLElement>(
        `[data-reveal-path="${CSS.escape(target)}"]`
      )
      if (!el) return
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      this.flashPath = target
      const nonce = this.revealNonce
      setTimeout(() => {
        if (this.revealNonce === nonce && this.flashPath === target) this.flashPath = null
      }, 1600)
    }

    private diffCacheKeyFor(checkpoint: TurnCheckpointSummary): string {
      // Live and final views share one checkpoint id; keeping the live diffs under
      // a distinct key makes completion swap in the authoritative persisted diffs.
      return checkpoint.status === 'active' ? `${checkpoint.id}:live` : checkpoint.id
    }

    private writeback(): void {
      if (!this.cache) return
      this.cache.checkpoints = this.checkpoints
      this.cache.selectedCheckpointId = this.selectedCheckpointId
    }

    async refreshLive(): Promise<void> {
      const generation = this.generation
      try {
        const next = await invoke('checkpoint:activeSummary', this.projectId, this.threadId)
        if (generation !== this.generation) return
        const finished = this.liveTurn !== null && next === null
        this.liveTurn = next
        if (next) this.liveRevision += 1
        if (finished) {
          // The turn just completed — pull its authoritative checkpoint in.
          void this.refresh(this.selectedCheckpointId)
        } else if (next && !this.selectedCheckpointId) {
          this.selectedCheckpointId = next.id
          void this.loadDiffs()
        }
      } catch {
        // Live tracking is supplementary; the completed history stays available.
      }
    }

    async refresh(preferredCheckpointId = this.selectedCheckpointId): Promise<void> {
      const request = this.refreshGuard.begin()
      const generation = this.generation
      this.loading = true
      this.error = ''
      try {
        const [nextCheckpoints, nextLive] = await Promise.all([
          invoke('checkpoint:list', this.projectId, this.threadId),
          invoke('checkpoint:activeSummary', this.projectId, this.threadId).catch(() => null)
        ])
        if (generation !== this.generation || !this.refreshGuard.isCurrent(request)) return
        this.checkpoints = nextCheckpoints
        this.liveTurn = nextLive
        const nextTurns = nextLive
          ? [nextLive, ...nextCheckpoints.filter((checkpoint) => checkpoint.status !== 'active')]
          : nextCheckpoints.filter((checkpoint) => checkpoint.status !== 'active')
        this.selectedCheckpointId =
          nextTurns.find((checkpoint) => checkpoint.id === preferredCheckpointId)?.id ??
          nextTurns[0]?.id ??
          null
        this.writeback()
        void this.loadDiffs()
      } catch (reason) {
        if (generation !== this.generation || !this.refreshGuard.isCurrent(request)) return
        this.error = reason instanceof Error ? reason.message : 'Change history could not be loaded.'
      } finally {
        if (generation === this.generation && this.refreshGuard.isCurrent(request)) {
          this.loading = false
        }
      }
    }

    private async loadDiffs(): Promise<void> {
      const generation = this.generation
      const checkpoint = this.selectedCheckpoint
      if (!checkpoint) {
        this.fileDiffs = []
        this.loadedDiffKey = null
        return
      }
      const key =
        checkpoint.status === 'active'
          ? `${this.diffCacheKeyFor(checkpoint)}#${this.liveRevision}`
          : this.diffCacheKeyFor(checkpoint)
      if (this.loadedDiffKey === key) {
        this.applyReveal()
        return
      }
      const isLive = checkpoint.status === 'active'
      this.loadedDiffKey = key
      this.fileDiffs = []
      this.loadingDiffs = true
      const results = await Promise.allSettled(
        checkpoint.changes.map((change) =>
          invoke(
            isLive ? 'checkpoint:liveDiff' : 'checkpoint:diff',
            this.projectId,
            this.threadId,
            checkpoint.id,
            change.path
          )
        )
      )
      if (generation !== this.generation) return
      this.fileDiffs = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value as TurnCheckpointFileDiff] : []
      )
      this.expandedDiffs = results.reduce<Record<string, boolean>>(
        (next, result) => {
          if (result.status === 'fulfilled') {
            const path = (result.value as TurnCheckpointFileDiff).path
            if (!(path in next)) next[path] = true
          }
          return next
        },
        { ...this.expandedDiffs }
      )
      this.loadingDiffs = false
      this.cache?.fileDiffsByCheckpoint.set(key, this.fileDiffs)
      this.applyReveal()
    }

    selectTurn(index: number): void {
      const checkpoint = this.turns[index]
      if (!checkpoint) return
      this.selectedCheckpointId = checkpoint.id
      this.writeback()
      void this.loadDiffs()
    }

    setMode(mode: ChangesMode): void {
      this.mode = mode
    }

    async openChange(checkpointId: string, path: string): Promise<void> {
      await projectFilesWorkspace.loadDirectory(this.projectId, '')
      contextSidebarState.openFiles(this.projectId, this.threadId)
      await projectFilesWorkspace.openCheckpointFile(this.projectId, checkpointId, path, 'diff')
    }

    toggleSelection(checkpointId: string, path: string): void {
      const selected = new SvelteSet(this.selections[checkpointId] ?? [])
      if (selected.has(path)) selected.delete(path)
      else selected.add(path)
      this.selections = { ...this.selections, [checkpointId]: [...selected] }
    }

    async restoreSelected(checkpointId: string): Promise<void> {
      const paths = this.selections[checkpointId] ?? []
      if (paths.length === 0) return
      const generation = this.generation
      this.restoringId = checkpointId
      this.error = ''
      try {
        const next = await invoke(
          'checkpoint:rollbackPaths',
          this.projectId,
          this.threadId,
          checkpointId,
          paths
        )
        if (generation !== this.generation) return
        this.checkpoints = next
        this.selections = { ...this.selections, [checkpointId]: [] }
        this.writeback()
      } catch (reason) {
        if (generation !== this.generation) return
        this.error = reason instanceof Error ? reason.message : 'Selected files could not be restored.'
      } finally {
        if (generation === this.generation) this.restoringId = null
      }
    }

    async restoreRun(checkpointId: string): Promise<void> {
      if (!window.confirm('Restore every file in this run to its pre-run state?')) return
      const generation = this.generation
      this.restoringId = checkpointId
      this.error = ''
      try {
        const next = await invoke(
          'checkpoint:rollback',
          this.projectId,
          this.threadId,
          checkpointId
        )
        if (generation !== this.generation) return
        this.checkpoints = next
        this.selections = { ...this.selections, [checkpointId]: [] }
        this.writeback()
      } catch (reason) {
        if (generation !== this.generation) return
        this.error = reason instanceof Error ? reason.message : 'The run could not be restored.'
      } finally {
        if (generation === this.generation) this.restoringId = null
      }
    }

    toggleDiff(path: string): void {
      this.expandedDiffs = { ...this.expandedDiffs, [path]: !(this.expandedDiffs[path] ?? true) }
    }

    get completedCheckpoints(): TurnCheckpointSummary[] {
      return this.checkpoints.filter((checkpoint) => checkpoint.status !== 'active')
    }

    // The in-progress turn leads the list so opening Changes during a run lands
    // on its live edits instead of the last completed turn.
    get turns(): TurnCheckpointSummary[] {
      return this.liveTurn ? [this.liveTurn, ...this.completedCheckpoints] : this.completedCheckpoints
    }

    get selectedIndex(): number {
      return Math.max(
        0,
        this.turns.findIndex((checkpoint) => checkpoint.id === this.selectedCheckpointId)
      )
    }

    get selectedCheckpoint(): TurnCheckpointSummary | null {
      return this.turns[this.selectedIndex] ?? null
    }

    start(): void {
      this.pollTimer = setInterval(() => void this.refreshLive(), 2_500)
      this.unsubscribeEvents = subscribe('agent:event', (...args: unknown[]) => {
        const raw = args[0] as Record<string, unknown>
        if (raw['projectId'] !== this.projectId || raw['threadId'] !== this.threadId) return
        const type = raw['type'] as string | undefined
        if (type === 'checkpoint.updated') {
          void this.refresh()
          return
        }
        if (type === 'checkpoint.liveUpdated') {
          void this.refreshLive()
        }
      })
      void this.refresh()
    }

    stop(): void {
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = null
      this.unsubscribeEvents?.()
      this.unsubscribeEvents = null
    }
  }
</script>

<script lang="ts">
  import {
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Eye,
    FileDiff,
    Loader2,
    RefreshCw
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FileDiffView from './FileDiffView.svelte'
  import Switch from '../ui/Switch.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { diffDetails } from './file-diff'

  interface Props {
    projectId: string
    threadId: string
    checkpointId: string | null
    /** File to reveal (scroll + highlight) when the Changes tab opens. */
    revealPath?: string | null
    /** Bumped on each reveal so re-clicking the same file re-triggers. */
    revealNonce?: number
  }

  let { projectId, threadId, checkpointId, revealPath = null, revealNonce = 0 }: Props = $props()

  // One owner per mounted instance, selected by the current thread identity. When
  // the parent reuses this instance across threads (no `{#key}`), syncIdentity
  // re-seeds the correct thread's cache and resets transient state.
  const controller = new DiffSidebarController()
  // Reactive identity/reveal sync without $effect: these re-run when their prop
  // dependencies change and re-seed/reset the shared controller accordingly.
  const _identity = $derived(controller.syncIdentity(projectId, threadId))
  const _preferred = $derived(controller.syncPreferredCheckpoint(checkpointId))
  const _reveal = $derived(controller.requestReveal(revealPath, revealNonce))

  function bindScrollContainer(node: HTMLElement): void {
    controller.scrollContainer = node
  }

  onMount(() => {
    controller.start()
    return () => controller.stop()
  })

  function filename(path: string): string {
    return path.split('/').at(-1) ?? path
  }

  function isMarkdown(path: string): boolean {
    return /\.(?:md|mdown|markdown)$/iu.test(path)
  }

  function formatDate(timestamp: number): string {
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(timestamp)
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  {#if controller.turns.length > 0}
    <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Show previous turn"
        title="Previous turn"
        disabled={controller.selectedIndex >= controller.turns.length - 1}
        onclick={() => controller.selectTurn(controller.selectedIndex + 1)}
      >
        <ChevronLeft size={13} />
      </button>
      <span class="text-[10px] font-medium tabular-nums text-muted">
        Turn {controller.turns.length - controller.selectedIndex} of {controller.turns.length}
      </span>
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Show next turn"
        title="Next turn"
        disabled={controller.selectedIndex <= 0}
        onclick={() => controller.selectTurn(controller.selectedIndex - 1)}
      >
        <ChevronRight size={13} />
      </button>
    </div>
  {/if}

  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
    <div
      class="flex items-center rounded-md bg-elevated p-0.5"
      role="group"
      aria-label="Changes view"
    >
      <button
        type="button"
        class={[
          'flex h-6 items-center gap-1.5 rounded px-2.5 text-[10px] font-medium transition-colors',
          controller.mode === 'diffs' ? 'bg-overlay text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={controller.mode === 'diffs'}
        title="Show each file's diff stacked by file"
        onclick={() => controller.setMode('diffs')}
      >
        Diffs
      </button>
      <button
        type="button"
        class={[
          'flex h-6 items-center gap-1.5 rounded px-2.5 text-[10px] font-medium transition-colors',
          controller.mode === 'files' ? 'bg-overlay text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={controller.mode === 'files'}
        title="Show the list of changed files with restore options"
        onclick={() => controller.setMode('files')}
      >
        File List
      </button>
    </div>
    <span class="flex-1"></span>
    <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={13} />
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      aria-label="Refresh change history"
      title="Refresh changes"
      disabled={controller.loading}
      onclick={() => void controller.refresh()}
    >
      <RefreshCw size={13} class={controller.loading ? 'animate-spin' : ''} />
    </button>
  </div>

  <div {@attach bindScrollContainer} class="min-h-0 flex-1 overflow-auto p-2">
    {#if controller.loading && controller.turns.length === 0}
      <div class="flex items-center justify-center gap-2 py-8 text-xs text-dimmed">
        <Loader2 size={14} class="animate-spin" />
        Loading changes
      </div>
    {:else if controller.error}
      <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2">
        <p class="text-[11px] leading-relaxed text-danger">{controller.error}</p>
      </div>
    {:else if controller.turns.length === 0}
      <div class="flex h-full items-center justify-center px-6 text-center">
        <div>
          <FileDiff size={22} class="mx-auto mb-2 text-dimmed" />
          <p class="text-xs font-medium text-muted">No recorded changes</p>
          <p class="mt-1 text-[10px] text-dimmed">
            Changes appear here the moment a run edits a file.
          </p>
        </div>
      </div>
    {:else}
      {@const checkpoint = controller.selectedCheckpoint}
      {#if checkpoint}
        {#if controller.mode === 'diffs'}
          <div class="space-y-2">
            {#if checkpoint.status === 'active'}
              <p class="px-1 pb-1 text-[10px] leading-relaxed text-dimmed">
                Live changes — this turn is still running.
              </p>
            {/if}
            {#if checkpoint.failure}
              <p
                class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
              >
                {checkpoint.failure}
              </p>
            {/if}
            {#if controller.loadingDiffs && controller.fileDiffs.length === 0}
              <div class="flex items-center justify-center gap-2 py-8 text-xs text-dimmed">
                <Loader2 size={14} class="animate-spin" />
                Loading diffs
              </div>
            {:else if controller.fileDiffs.length === 0}
              <p class="px-3 py-4 text-center text-[10px] text-dimmed">
                {checkpoint.changes.length === 0
                  ? 'No file changes detected.'
                  : 'No file diffs are available.'}
              </p>
            {:else}
              {#each controller.fileDiffs as fileDiff (fileDiff.path)}
                {@const details = fileDiff.binary
                  ? null
                  : diffDetails(fileDiff.before, fileDiff.after)}
                {@const stats = details}
                {@const expanded = controller.expandedDiffs[fileDiff.path] ?? true}
                <section
                  data-reveal-path={fileDiff.path}
                  class={[
                    'overflow-hidden rounded-md border transition-colors',
                    controller.flashPath === fileDiff.path
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface'
                  ]}
                >
                  <div class="flex min-h-9 items-center pr-1.5">
                    <button
                      type="button"
                      class="flex min-h-9 min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors hover:bg-elevated"
                      aria-expanded={expanded}
                      title={expanded
                        ? `Collapse diff for ${fileDiff.path}`
                        : `Show diff for ${fileDiff.path}`}
                      onclick={() => controller.toggleDiff(fileDiff.path)}
                    >
                      <FileTypeIcon path={fileDiff.path} size={13} />
                      <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                        {fileDiff.path}
                      </span>
                      {#if fileDiff.binary}
                        <span class="shrink-0 text-[9px] text-dimmed">binary</span>
                      {:else if stats}
                        <span class="shrink-0 font-mono text-[10px] tabular-nums text-success">
                          +{stats.additions}
                        </span>
                        <span class="shrink-0 font-mono text-[10px] tabular-nums text-danger">
                          −{stats.deletions}
                        </span>
                      {/if}
                      {#if expanded}
                        <ChevronDown size={12} class="shrink-0 text-dimmed" />
                      {:else}
                        <ChevronRight size={12} class="shrink-0 text-dimmed" />
                      {/if}
                    </button>
                    {#if checkpoint.status !== 'active'}
                      <button
                        type="button"
                        class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                        aria-label={`Open ${fileDiff.path} in the changes sidebar`}
                        title={`Open ${fileDiff.path} in the changes sidebar`}
                        onclick={() => void controller.openChange(checkpoint.id, fileDiff.path)}
                      >
                        <Eye size={13} />
                      </button>
                    {/if}
                  </div>
                  {#if expanded}
                    <div class="border-t border-border">
                      <FileDiffView diff={fileDiff} maxHeight="24rem" />
                    </div>
                  {/if}
                </section>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="space-y-2">
            <section class="rounded-lg border border-border bg-surface">
              <div class="flex min-h-10 items-center gap-2 px-3 py-2">
                <FileDiff size={13} class="shrink-0 text-info" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
                      {checkpoint.label}
                    </span>
                    {#if checkpoint.status === 'active'}
                      <span
                        class="shrink-0 rounded bg-info/10 px-1.5 py-0.5 text-[9px] font-semibold text-info"
                      >
                        In progress
                      </span>
                    {/if}
                  </span>
                  <span class="block text-[9px] text-dimmed">
                    {formatDate(checkpoint.completedAt ?? checkpoint.createdAt)}
                  </span>
                </span>
                <span class="tabular-nums text-[10px] text-dimmed">
                  {checkpoint.changes.length}
                </span>
              </div>
              <div class="border-t border-border py-1">
                {#if checkpoint.failure}
                  <p class="px-3 py-1.5 text-[10px] leading-relaxed text-danger">
                    {checkpoint.failure}
                  </p>
                {/if}
                {#if checkpoint.status === 'active'}
                  <p class="px-3 py-1.5 text-[10px] leading-relaxed text-dimmed">
                    This turn is still running — files update here as the agent edits them.
                  </p>
                {/if}
                {#if checkpoint.changes.length === 0}
                  <p class="px-3 py-2 text-[10px] text-dimmed">No file changes detected.</p>
                {:else}
                  {#each checkpoint.changes as change (`${change.kind}:${change.path}`)}
                    <div
                      class="flex h-8 items-center gap-2 px-3 transition-colors hover:bg-elevated"
                    >
                      {#if checkpoint.status !== 'rolled_back' && checkpoint.status !== 'active'}
                        <Switch
                          checked={(controller.selections[checkpoint.id] ?? []).includes(change.path)}
                          disabled={checkpoint.rolledBackPaths?.includes(change.path)}
                          aria-label={`Select ${change.path} to restore`}
                          onchange={() => controller.toggleSelection(checkpoint.id, change.path)}
                        />
                      {/if}
                      <span
                        class={[
                          'w-4 shrink-0 text-center font-mono text-[10px] font-semibold',
                          change.kind === 'created'
                            ? 'text-success'
                            : change.kind === 'deleted'
                              ? 'text-danger'
                              : 'text-warning'
                        ]}
                      >
                        {change.kind === 'created' ? 'A' : change.kind === 'deleted' ? 'D' : 'M'}
                      </span>
                      <FileTypeIcon path={change.path} />
                      {#if checkpoint.status === 'active'}
                        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                          {change.path}
                        </span>
                      {:else}
                        <button
                          type="button"
                          class="min-w-0 flex-1 truncate text-left font-mono text-[10px] text-muted hover:text-foreground"
                          title={`Open ${change.path}`}
                          onclick={() => void controller.openChange(checkpoint.id, change.path)}
                        >
                          {isMarkdown(change.path) ? filename(change.path) : change.path}
                        </button>
                      {/if}
                      {#if change.binary}
                        <span class="text-[9px] text-dimmed">binary</span>
                      {/if}
                    </div>
                  {/each}
                  {#if checkpoint.status !== 'rolled_back' && checkpoint.status !== 'active'}
                    <div class="flex items-center gap-2 border-t border-border px-3 py-2">
                      <button
                        type="button"
                        class="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                        disabled={controller.restoringId === checkpoint.id ||
                          (controller.selections[checkpoint.id] ?? []).length === 0}
                        onclick={() => void controller.restoreSelected(checkpoint.id)}
                      >
                        Restore selected
                      </button>
                      <button
                        type="button"
                        class="rounded-md px-2 py-1 text-[10px] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                        disabled={controller.restoringId === checkpoint.id}
                        onclick={() => void controller.restoreRun(checkpoint.id)}
                      >
                        {controller.restoringId === checkpoint.id ? 'Restoring…' : 'Restore run'}
                      </button>
                    </div>
                  {/if}
                {/if}
              </div>
            </section>
          </div>
        {/if}
      {/if}
    {/if}
  </div>
</div>