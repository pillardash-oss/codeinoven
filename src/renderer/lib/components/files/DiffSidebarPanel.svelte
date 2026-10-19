<script module lang="ts">
  import { diffDetailsAsync } from './file-diff-async'
  import type { DiffDetails } from './file-diff'
  import { SvelteSet } from 'svelte/reactivity'
  import type { AgentEvent, TurnCheckpointFileDiff, TurnCheckpointSummary } from '$shared/types'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { LatestRequestGuard } from '$lib/refresh-guard'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { appQuitState } from '$lib/stores/app-quit.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'

  type ChangesMode = 'diffs' | 'files'

  /** Durable per-thread state that survives the panel's remount cycle. */
  interface DiffPanelCache {
    checkpoints: TurnCheckpointSummary[]
    selectedCheckpointId: string | null
  }

  // A plain module-level object (not reactive state) so re-seeding can read it
  // from inside a reactive effect without triggering state_unsafe_mutation. The
  // entries are plain Records so the controller can re-seed
  // with direct property access (no function calls) inside an effect.
  const panelCache: Record<string, DiffPanelCache> = {}

  /**
   * Owns the complete panel state for one mounted instance. The parent may reuse
   * this instance across threads (no `{#key}`); an internal effect watches the
   * identity fields and re-seeds durable state from the shared cache while
   * resetting every transient field, so the panel stays correct without relying
   * on a keyed parent. A generation counter invalidates any in-flight async work
   * from a prior identity so stale results never overwrite the current thread.
   */
  export class DiffSidebarController {
    projectId = $state('')
    threadId = $state('')
    checkpointId = $state<string | null>(null)
    revealPath = $state<string | null>(null)
    revealNonce = $state(0)
    checkpoints = $state.raw<TurnCheckpointSummary[]>([])
    /** The running turn's live change summary   absent once the turn completes. */
    liveTurn = $state.raw<TurnCheckpointSummary | null>(null)
    selectedCheckpointId = $state<string | null>(null)
    loading = $state(false)
    error = $state('')
    restoringId = $state<string | null>(null)
    /** The run a Restore confirmation is open for, or null. The request is parked
     *  here while the shared confirmation asks, so the question is asked with the
     *  app's own dialog instead of a native browser one. */
    pendingRestoreId = $state<string | null>(null)
    /** The single file an Undo confirmation is open for, or null. */
    pendingUndoPath = $state<{ checkpointId: string; path: string } | null>(null)
    /** The one path a per-file undo or redo is running for, so its own row
     *  reports the work instead of the whole panel. */
    busyPath = $state<string | null>(null)
    selections = $state<Record<string, string[]>>({})
    mode = $state<ChangesMode>('diffs')
    fileDiffs = $state.raw<TurnCheckpointFileDiff[]>([])
    diffDetails = $state.raw<Record<string, DiffDetails>>({})
    diffErrors = $state.raw<Record<string, string>>({})
    pageStart = $state(0)
    readonly pageSize = 20
    private diffAbort: AbortController | null = null
    private readBatch: Promise<unknown> = Promise.resolve()
    loadingDiffs = $state(false)
    expandedDiffs = $state<Record<string, boolean>>({})
    flashPath = $state<string | null>(null)
    scrollContainer = $state<HTMLElement | null>(null)

    private refreshGuard = new LatestRequestGuard()
    private liveRefreshGuard = new LatestRequestGuard()
    private diffRefreshGuard = new LatestRequestGuard()
    private generation = 0
    private cache: DiffPanelCache | null = null
    private lastSeededKey: string | null = null
    private pollTimer: ReturnType<typeof setInterval> | null = null
    private unsubscribeEvents: (() => void) | null = null

    constructor() {
      // React to identity changes: re-seed durable state from the shared cache
      // and reset transient state. Runs whenever projectId/threadId change and
      // again on mount, without mutating state during a derived evaluation. The
      // generation only advances on a real switch from a prior identity, so the
      // first seed (mount or the parent handing in a thread) does not invalidate
      // the refresh issued right after it.
      $effect.root(() => {
        $effect(() => {
          if (!this.projectId || !this.threadId) return
          const key = `${this.projectId}:${this.threadId}`
          if (key === this.lastSeededKey) return
          const switched = this.lastSeededKey !== null
          this.lastSeededKey = key
          if (switched) this.generation += 1
          let entry = panelCache[key]
          if (!entry) {
            entry = { checkpoints: [], selectedCheckpointId: null }
            panelCache[key] = entry
          }
          this.cache = entry
          this.checkpoints = entry.checkpoints
          this.selectedCheckpointId = entry.selectedCheckpointId
          this.diffAbort?.abort()
          this.fileDiffs = []
          this.diffDetails = {}
          this.diffErrors = {}
          this.pageStart = 0
          this.liveTurn = null
          this.loading = false
          this.error = ''
          this.restoringId = null
          this.pendingUndoPath = null
          this.busyPath = null
          this.selections = {}
          this.mode = 'diffs'
          this.loadingDiffs = false
          this.expandedDiffs = {}
          this.flashPath = null
        })
      })
    }

    applyReveal(): void {
      const target = this.revealPath
      if (!target || this.revealNonce <= 0) return
      const index =
        this.selectedCheckpoint?.changes.findIndex((change) => change.path === target) ?? -1
      if (index >= 0 && Math.floor(index / this.pageSize) * this.pageSize !== this.pageStart) {
        this.pageStart = Math.floor(index / this.pageSize) * this.pageSize
        void this.loadDiffs()
        return
      }
      if (!this.fileDiffs.some((diff) => diff.path === target)) return
      this.expandedDiffs = { [target]: true }
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

    private writeback(): void {
      if (!this.cache) return
      this.cache.checkpoints = this.checkpoints
      this.cache.selectedCheckpointId = this.selectedCheckpointId
    }

    async refreshLive(): Promise<void> {
      // The live summary is a database read. Stop on the quit signal: the main
      // process closes the database while the window is still open, and this
      // poll would otherwise land on it.
      if (appQuitState.quitting || this.loadingDiffs) return
      const request = this.liveRefreshGuard.begin()
      const generation = this.generation
      try {
        const next = await invoke('checkpoint:activeSummary', this.projectId, this.threadId)
        if (generation !== this.generation || !this.liveRefreshGuard.isCurrent(request)) return
        const previousLive = this.liveTurn
        const finished = previousLive !== null && next === null
        this.liveTurn = next
        this.syncPolling()
        if (finished) {
          // The turn just completed   pull its authoritative checkpoint in.
          void this.refresh(this.selectedCheckpointId)
        } else if (next && !previousLive) {
          // A running turn takes focus once it produces its first file change.
          // Later refreshes preserve an explicit historical-turn selection.
          this.selectedCheckpointId = next.id
          this.writeback()
          void this.loadDiffs()
        } else if (next && this.selectedCheckpointId === next.id) {
          // The selected live checkpoint keeps its id for the whole turn, so
          // reload its diff whenever the revision changes.
          void this.loadDiffs()
        }
      } catch {
        // Live tracking is supplementary; the completed history stays available.
      }
    }

    async refresh(
      preferredCheckpointId = this.checkpointId ?? this.selectedCheckpointId
    ): Promise<void> {
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
        this.syncPolling()
        const nextTurns = nextLive
          ? [nextLive, ...nextCheckpoints.filter((checkpoint) => checkpoint.status !== 'active')]
          : nextCheckpoints.filter((checkpoint) => checkpoint.status !== 'active')
        const previousCheckpointId = this.selectedCheckpointId
        this.selectedCheckpointId =
          nextTurns.find((checkpoint) => checkpoint.id === preferredCheckpointId)?.id ??
          nextTurns[0]?.id ??
          null
        if (this.selectedCheckpointId !== previousCheckpointId) this.pageStart = 0
        this.writeback()
        void this.loadDiffs()
      } catch (reason) {
        if (generation !== this.generation || !this.refreshGuard.isCurrent(request)) return
        this.error =
          reason instanceof Error ? reason.message : 'Change history could not be loaded.'
      } finally {
        if (generation === this.generation && this.refreshGuard.isCurrent(request)) {
          this.loading = false
        }
      }
    }

    private async loadDiffs(): Promise<void> {
      const generation = this.generation
      const checkpoint = this.selectedCheckpoint
      this.diffAbort?.abort()
      if (this.mode !== 'diffs') {
        this.fileDiffs = []
        this.diffDetails = {}
        this.diffErrors = {}
        this.loadingDiffs = false
        return
      }
      const abort = new AbortController()
      this.diffAbort = abort
      if (!checkpoint) {
        this.fileDiffs = []
        this.loadingDiffs = false
        return
      }
      this.pageStart = Math.min(
        this.pageStart,
        Math.max(0, Math.ceil(checkpoint.changes.length / this.pageSize) - 1) * this.pageSize
      )
      const request = this.diffRefreshGuard.begin()
      const current = (): boolean =>
        !abort.signal.aborted &&
        generation === this.generation &&
        this.diffRefreshGuard.isCurrent(request)
      this.fileDiffs = []
      this.diffDetails = {}
      this.diffErrors = {}
      this.loadingDiffs = true
      const changes = checkpoint.changes.slice(this.pageStart, this.pageStart + this.pageSize)
      // Two file reads per batch, then sequential worker computation. Publish each
      // completed file and yield before requesting another batch. Retain one page.
      for (let index = 0; index < changes.length; index += 2) {
        if (!current()) return
        const batch = this.readBatch.then(() => {
          if (!current()) return []
          return Promise.allSettled(
            changes
              .slice(index, index + 2)
              .map((change) =>
                invoke(
                  checkpoint.status === 'active' ? 'checkpoint:liveDiff' : 'checkpoint:diff',
                  this.projectId,
                  this.threadId,
                  checkpoint.id,
                  change.path
                )
              )
          )
        })
        this.readBatch = batch.catch(() => {})
        const results = await batch
        for (let offset = 0; offset < results.length; offset += 1) {
          if (!current()) return
          const result = results[offset]
          const path = changes[index + offset].path
          if (result.status === 'rejected') {
            this.diffErrors = { ...this.diffErrors, [path]: `Could not load the diff for ${path}.` }
            this.fileDiffs = [
              ...this.fileDiffs,
              { path, kind: changes[index + offset].kind, binary: false, truncated: false }
            ]
            continue
          }
          const diff = result.value
          if (!diff.binary) {
            try {
              const details = await diffDetailsAsync(
                {
                  before: diff.before,
                  after: diff.after,
                  beforeStartLine: diff.beforeStartLine,
                  afterStartLine: diff.afterStartLine
                },
                abort.signal
              )
              if (!current()) return
              this.diffDetails = { ...this.diffDetails, [path]: details }
            } catch (reason) {
              if (!current()) return
              this.diffErrors = {
                ...this.diffErrors,
                [path]: reason instanceof Error ? reason.message : 'Diff preview failed.'
              }
            }
          }
          if (!current()) return
          this.fileDiffs = [...this.fileDiffs, diff]
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      }
      if (!current()) return
      this.loadingDiffs = false
      this.applyReveal()
    }

    changePage(direction: number): void {
      this.expandedDiffs = {}
      const total = this.selectedCheckpoint?.changes.length ?? 0
      this.pageStart = Math.max(
        0,
        Math.min(
          Math.max(0, Math.ceil(total / this.pageSize) - 1) * this.pageSize,
          this.pageStart + direction * this.pageSize
        )
      )
      void this.loadDiffs()
    }

    selectTurn(index: number): void {
      const checkpoint = this.turns[index]
      if (!checkpoint) return
      this.pageStart = 0
      this.expandedDiffs = {}
      this.selectedCheckpointId = checkpoint.id
      this.writeback()
      void this.loadDiffs()
    }

    setMode(mode: ChangesMode): void {
      this.mode = mode
      void this.loadDiffs()
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
      await this.applyPaths(checkpointId, paths, 'undo')
    }

    /**
     * One file, undone on its own. A turn is rarely all right or all wrong, so
     * a file that should not stay is restored without touching the rest of the
     * run. It discards the agent's edit, so the shared confirmation asks first.
     */
    requestUndoPath(checkpointId: string, path: string): void {
      this.pendingUndoPath = { checkpointId, path }
    }

    cancelUndoPath(): void {
      this.pendingUndoPath = null
    }

    async confirmUndoPath(): Promise<void> {
      const pending = this.pendingUndoPath
      if (!pending) return
      this.pendingUndoPath = null
      await this.applyPaths(pending.checkpointId, [pending.path], 'undo')
    }

    /** Re-applies one undone file from its snapshot. Nothing is lost, so it runs straight away. */
    async redoPath(checkpointId: string, path: string): Promise<void> {
      await this.applyPaths(checkpointId, [path], 'redo')
    }

    /** The one place undo and redo call the checkpoint IPC, so both share the
     *  generation guard, the busy flags, and the selection cleanup. */
    private async applyPaths(
      checkpointId: string,
      paths: string[],
      direction: 'undo' | 'redo'
    ): Promise<void> {
      if (paths.length === 0) return
      const generation = this.generation
      this.restoringId = checkpointId
      this.busyPath = paths.length === 1 ? paths[0] : null
      this.error = ''
      try {
        const next =
          direction === 'undo'
            ? await invoke(
                'checkpoint:rollbackPaths',
                this.projectId,
                this.threadId,
                checkpointId,
                paths
              )
            : await invoke(
                'checkpoint:redoPaths',
                this.projectId,
                this.threadId,
                checkpointId,
                paths
              )
        if (generation !== this.generation) return
        this.checkpoints = next
        const restored = new Set(paths)
        this.selections = {
          ...this.selections,
          [checkpointId]: (this.selections[checkpointId] ?? []).filter(
            (path) => !restored.has(path)
          )
        }
        this.writeback()
      } catch (reason) {
        if (generation !== this.generation) return
        if (reason instanceof Error) {
          this.error = reason.message
        } else {
          this.error =
            direction === 'undo'
              ? 'Selected files could not be restored.'
              : 'The file could not be re-applied.'
        }
      } finally {
        if (generation === this.generation) {
          this.restoringId = null
          this.busyPath = null
        }
      }
    }

    /** Park the run so the confirmation can ask before anything is restored. */
    requestRestoreRun(checkpointId: string): void {
      this.pendingRestoreId = checkpointId
    }

    cancelRestoreRun(): void {
      this.pendingRestoreId = null
    }

    async confirmRestoreRun(): Promise<void> {
      const checkpointId = this.pendingRestoreId
      if (checkpointId === null) return
      this.pendingRestoreId = null
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
      const expanded =
        this.expandedDiffs[path] ??
        (Object.keys(this.expandedDiffs).length === 0 && this.fileDiffs[0]?.path === path)
      this.expandedDiffs = { [path]: !expanded }
    }

    get completedCheckpoints(): TurnCheckpointSummary[] {
      return this.checkpoints.filter((checkpoint) => checkpoint.status !== 'active')
    }

    // The in-progress turn leads the list so opening Changes during a run lands
    // on its live edits instead of the last completed turn.
    get turns(): TurnCheckpointSummary[] {
      return this.liveTurn
        ? [this.liveTurn, ...this.completedCheckpoints]
        : this.completedCheckpoints
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

    private syncPolling(): void {
      if (this.liveTurn && !this.pollTimer) {
        this.pollTimer = setInterval(() => void this.refreshLive(), 2_500)
      } else if (!this.liveTurn && this.pollTimer) {
        clearInterval(this.pollTimer)
        this.pollTimer = null
      }
    }

    start(): void {
      this.unsubscribeEvents = subscribe('agent:event', (...args: unknown[]) => {
        const event = args[0] as AgentEvent
        if (!('projectId' in event) || !('threadId' in event)) return
        if (event.projectId !== this.projectId || event.threadId !== this.threadId) return
        if (event.type === 'checkpoint.updated') {
          void this.refresh()
          return
        }
        if (event.type === 'checkpoint.liveUpdated') {
          void this.refreshLive()
        }
      })
      void this.refresh()
    }

    stop(): void {
      this.generation += 1
      this.diffAbort?.abort()
      this.fileDiffs = []
      this.diffDetails = {}
      if (this.pollTimer) clearInterval(this.pollTimer)
      this.pollTimer = null
      this.unsubscribeEvents?.()
      this.unsubscribeEvents = null
    }
  }
</script>

<script lang="ts">
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { onMount } from 'svelte'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FileDiffView from './FileDiffView.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Switch from '../ui/Switch.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'

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

  // One owner per mounted instance. Each $effect runs whenever its prop changes
  // and syncs that prop into the controller through a direct field write   the
  // identity re-seed happens inside the controller itself, so prop changes reach
  // the correct thread's state without mutating during a derived evaluation.
  const controller = new DiffSidebarController()
  $effect(() => {
    controller.projectId = projectId
    controller.threadId = threadId
  })
  $effect(() => {
    controller.checkpointId = checkpointId
  })
  $effect(() => {
    controller.revealPath = revealPath
    controller.revealNonce = revealNonce
  })

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
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  {#if controller.turns.length > 0}
    <div class="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-2">
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Show previous turn"
        title="Previous turn"
        disabled={controller.selectedIndex >= controller.turns.length - 1}
        onclick={() => controller.selectTurn(controller.selectedIndex + 1)}
      >
        <CioBack size={13} />
      </button>
      <span class="text-[0.625rem] font-medium tabular-nums text-muted">
        Turn {controller.turns.length - controller.selectedIndex} of {controller.turns.length}
      </span>
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
        aria-label="Show next turn"
        title="Next turn"
        disabled={controller.selectedIndex <= 0}
        onclick={() => controller.selectTurn(controller.selectedIndex - 1)}
      >
        <CioForward size={13} />
      </button>
    </div>
  {/if}

  <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2.5">
    <div
      class="flex shrink-0 items-center gap-0.5 border border-border bg-elevated p-0.5"
      role="group"
      aria-label="Changes view"
    >
      <button
        type="button"
        class={[
          'flex h-5 w-6 shrink-0 items-center justify-center transition-colors',
          controller.mode === 'diffs'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={controller.mode === 'diffs'}
        title="Show each file's diff stacked by file"
        aria-label="Show file diffs"
        onclick={() => controller.setMode('diffs')}
      >
        <CioDiff size={12} aria-hidden="true" />
      </button>
      <button
        type="button"
        class={[
          'flex h-5 w-6 shrink-0 items-center justify-center transition-colors',
          controller.mode === 'files'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={controller.mode === 'files'}
        title="Show the list of changed files with restore options"
        aria-label="Show changed file list"
        onclick={() => controller.setMode('files')}
      >
        <CioCommit size={12} aria-hidden="true" />
      </button>
    </div>
    <span class="flex-1"></span>
    <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={13} />
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      aria-label={controller.loading || controller.loadingDiffs
        ? 'Scanning changes'
        : 'Refresh change history'}
      title={controller.loading || controller.loadingDiffs ? 'Scanning changes' : 'Refresh changes'}
      disabled={controller.loading || controller.loadingDiffs}
      onclick={() => void controller.refresh()}
    >
      <CioRefresh
        size={13}
        class={controller.loading || controller.loadingDiffs ? 'animate-spin' : ''}
      />
    </button>
  </div>

  <div
    {@attach bindScrollContainer}
    class="min-h-0 flex-1 overflow-auto p-2"
    aria-busy={controller.loading || controller.loadingDiffs}
  >
    {#if controller.loading && controller.turns.length === 0}
      <div class="min-h-12"></div>
    {:else if controller.error}
      <div class="border border-danger/20 bg-danger/10 px-3 py-2">
        <p class="text-[0.6875rem] leading-relaxed text-danger">{controller.error}</p>
      </div>
    {:else if controller.turns.length === 0}
      <div class="flex h-full items-center justify-center px-6 text-center">
        <div>
          <CioDiff size={22} class="mx-auto mb-2 text-dimmed" />
          <p class="text-xs font-medium text-muted">No recorded changes</p>
          <p class="mt-1 text-[0.625rem] text-dimmed">
            Changes appear here the moment a run edits a file.
          </p>
        </div>
      </div>
    {:else}
      {@const checkpoint = controller.selectedCheckpoint}
      {#if checkpoint}
        {#if checkpoint.changes.length > controller.pageSize}
          <div class="flex items-center justify-end gap-2 text-xs text-muted">
            <span
              >{controller.pageStart + 1}–{Math.min(
                controller.pageStart + controller.pageSize,
                checkpoint.changes.length
              )} of {checkpoint.changes.length} files</span
            >
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
              title="Previous files"
              aria-label="Previous files"
              disabled={controller.pageStart === 0}
              onclick={() => controller.changePage(-1)}><CioBack size={13} /></button
            >
            <button
              type="button"
              class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
              title="Next files"
              aria-label="Next files"
              disabled={controller.pageStart + controller.pageSize >= checkpoint.changes.length}
              onclick={() => controller.changePage(1)}><CioForward size={13} /></button
            >
          </div>
        {/if}
        {#if controller.mode === 'diffs'}
          <div class="space-y-2">
            {#if checkpoint.status === 'active'}
              <p class="px-1 pb-1 text-[0.625rem] leading-relaxed text-dimmed">
                Live changes this turn is still running.
              </p>
            {/if}
            {#if checkpoint.failure}
              <p
                class="border border-danger/20 bg-danger/10 px-3 py-1.5 text-[0.625rem] leading-relaxed text-danger"
              >
                {checkpoint.failure}
              </p>
            {/if}
            {#if controller.loadingDiffs && controller.fileDiffs.length === 0}
              <div class="min-h-12"></div>
            {:else if controller.fileDiffs.length === 0}
              <p class="px-3 py-4 text-center text-[0.625rem] text-dimmed">
                {checkpoint.changes.length === 0
                  ? 'No file changes detected.'
                  : 'No file diffs are available.'}
              </p>
            {:else}
              {#each controller.fileDiffs as fileDiff (fileDiff.path)}
                {@const details = controller.diffDetails[fileDiff.path] ?? null}
                {@const stats = details}
                {@const expanded =
                  controller.expandedDiffs[fileDiff.path] ??
                  (Object.keys(controller.expandedDiffs).length === 0 &&
                    controller.fileDiffs[0]?.path === fileDiff.path)}
                {@const undone = checkpoint.rolledBackPaths?.includes(fileDiff.path) ?? false}
                <section
                  data-reveal-path={fileDiff.path}
                  class={[
                    'overflow-hidden border transition-colors',
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
                      <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">
                        {fileDiff.path}
                      </span>
                      {#if fileDiff.binary}
                        <span class="shrink-0 text-[0.5625rem] text-dimmed">binary</span>
                      {:else if stats}
                        <span class="shrink-0 font-mono text-[0.625rem] tabular-nums text-success">
                          +{stats.additions}
                        </span>
                        <span class="shrink-0 font-mono text-[0.625rem] tabular-nums text-danger">
                          −{stats.deletions}
                        </span>
                      {/if}
                      {#if undone}
                        <span class="shrink-0 text-[0.5625rem] text-dimmed">undone</span>
                      {/if}
                      {#if expanded}
                        <CioChevronDown size={12} class="shrink-0 text-dimmed" />
                      {:else}
                        <CioForward size={12} class="shrink-0 text-dimmed" />
                      {/if}
                    </button>
                    {#if checkpoint.status !== 'active'}
                      <button
                        type="button"
                        class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                        aria-label={`Open ${fileDiff.path} in the changes sidebar`}
                        title={`Open ${fileDiff.path} in the changes sidebar`}
                        onclick={() => void controller.openChange(checkpoint.id, fileDiff.path)}
                      >
                        <CioEye size={13} />
                      </button>
                      <button
                        type="button"
                        class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={controller.restoringId !== null}
                        aria-label={undone
                          ? `Redo the changes to ${fileDiff.path}`
                          : `Undo the changes to ${fileDiff.path}`}
                        title={undone
                          ? `Redo the changes to ${fileDiff.path}`
                          : `Undo the changes to ${fileDiff.path}`}
                        onclick={() =>
                          undone
                            ? void controller.redoPath(checkpoint.id, fileDiff.path)
                            : controller.requestUndoPath(checkpoint.id, fileDiff.path)}
                      >
                        {#if controller.busyPath === fileDiff.path}
                          <CioSpinner size={13} class="animate-spin" />
                        {:else if undone}
                          <CioRefresh size={13} />
                        {:else}
                          <CioUndo size={13} />
                        {/if}
                      </button>
                    {/if}
                  </div>
                  {#if expanded}
                    <div class="border-t border-border">
                      {#if controller.diffErrors[fileDiff.path]}
                        <p class="px-3 py-3 text-xs text-muted" role="note">
                          {controller.diffErrors[fileDiff.path]}
                        </p>
                      {:else}
                        <FileDiffView diff={fileDiff} preparedDetails={details} maxHeight="24rem" />
                      {/if}
                    </div>
                  {/if}
                </section>
              {/each}
            {/if}
          </div>
        {:else}
          <div class="space-y-2">
            <section class="border border-border bg-surface">
              <div class="flex min-h-10 items-center gap-2 px-3 py-2">
                <CioDiff size={13} class="shrink-0 text-info" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5">
                    <span
                      class="min-w-0 flex-1 truncate text-[0.6875rem] font-medium text-foreground"
                    >
                      {checkpoint.label}
                    </span>
                    {#if checkpoint.status === 'active'}
                      <span
                        class="shrink-0 bg-info/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold text-info"
                      >
                        In progress
                      </span>
                    {/if}
                  </span>
                  <span class="block text-[0.5625rem] text-dimmed">
                    {formatDateTimeCompact(checkpoint.completedAt ?? checkpoint.createdAt)}
                  </span>
                </span>
                <span class="tabular-nums text-[0.625rem] text-dimmed">
                  {checkpoint.changes.length}
                </span>
              </div>
              <div class="border-t border-border py-1">
                {#if checkpoint.failure}
                  <p class="px-3 py-1.5 text-[0.625rem] leading-relaxed text-danger">
                    {checkpoint.failure}
                  </p>
                {/if}
                {#if checkpoint.status === 'active'}
                  <p class="px-3 py-1.5 text-[0.625rem] leading-relaxed text-dimmed">
                    This turn is still running files update here as the agent edits them.
                  </p>
                {/if}
                {#if checkpoint.changes.length === 0}
                  <p class="px-3 py-2 text-[0.625rem] text-dimmed">No file changes detected.</p>
                {:else}
                  {#each checkpoint.changes.slice(controller.pageStart, controller.pageStart + controller.pageSize) as change (`${change.kind}:${change.path}`)}
                    {@const undone = checkpoint.rolledBackPaths?.includes(change.path) ?? false}
                    <div
                      class="flex h-8 items-center gap-2 px-3 transition-colors hover:bg-elevated"
                    >
                      {#if checkpoint.status !== 'rolled_back' && checkpoint.status !== 'active'}
                        <Switch
                          checked={(controller.selections[checkpoint.id] ?? []).includes(
                            change.path
                          )}
                          disabled={checkpoint.rolledBackPaths?.includes(change.path)}
                          aria-label={`Select ${change.path} to restore`}
                          onchange={() => controller.toggleSelection(checkpoint.id, change.path)}
                        />
                      {/if}
                      <span
                        class={[
                          'w-4 shrink-0 text-center font-mono text-[0.625rem] font-semibold',
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
                        <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">
                          {change.path}
                        </span>
                      {:else}
                        <button
                          type="button"
                          class="min-w-0 flex-1 truncate text-left font-mono text-[0.625rem] text-muted hover:text-foreground"
                          class:line-through={undone}
                          title={`Open ${change.path}`}
                          onclick={() => void controller.openChange(checkpoint.id, change.path)}
                        >
                          {isMarkdown(change.path) ? filename(change.path) : change.path}
                        </button>
                      {/if}
                      {#if change.binary}
                        <span class="text-[0.5625rem] text-dimmed">binary</span>
                      {/if}
                      {#if checkpoint.status !== 'active'}
                        <button
                          type="button"
                          class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                          disabled={controller.restoringId !== null}
                          aria-label={undone
                            ? `Redo the changes to ${change.path}`
                            : `Undo the changes to ${change.path}`}
                          title={undone
                            ? `Redo the changes to ${change.path}`
                            : `Undo the changes to ${change.path}`}
                          onclick={() =>
                            undone
                              ? void controller.redoPath(checkpoint.id, change.path)
                              : controller.requestUndoPath(checkpoint.id, change.path)}
                        >
                          {#if controller.busyPath === change.path}
                            <CioSpinner size={13} class="animate-spin" />
                          {:else if undone}
                            <CioRefresh size={13} />
                          {:else}
                            <CioUndo size={13} />
                          {/if}
                        </button>
                      {/if}
                    </div>
                  {/each}
                  {#if checkpoint.status !== 'rolled_back' && checkpoint.status !== 'active'}
                    <div class="flex items-center gap-2 border-t border-border px-3 py-2">
                      <button
                        type="button"
                        class="border border-border px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                        disabled={controller.restoringId === checkpoint.id ||
                          (controller.selections[checkpoint.id] ?? []).length === 0}
                        onclick={() => void controller.restoreSelected(checkpoint.id)}
                      >
                        Restore selected
                      </button>
                      <button
                        type="button"
                        class="px-2 py-1 text-[0.625rem] font-medium text-danger hover:bg-danger/10 disabled:opacity-40"
                        disabled={controller.restoringId === checkpoint.id}
                        onclick={() => controller.requestRestoreRun(checkpoint.id)}
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

  <ConfirmDialog
    open={controller.pendingRestoreId !== null}
    title="Restore every file in this run to its pre-run state?"
    onCancel={() => controller.cancelRestoreRun()}
    onConfirm={() => void controller.confirmRestoreRun()}
    confirmLabel="Restore run"
    busy={controller.restoringId !== null}
  >
    <p>The files this run changed go back to the content they had before it started.</p>
  </ConfirmDialog>

  <ConfirmDialog
    open={controller.pendingUndoPath !== null}
    title="Undo the changes to this file?"
    onCancel={() => controller.cancelUndoPath()}
    onConfirm={() => void controller.confirmUndoPath()}
    confirmLabel="Undo file"
    busy={controller.restoringId !== null}
  >
    <p>
      <span class="font-mono text-foreground">{controller.pendingUndoPath?.path}</span> goes back to the
      content it had before this turn started. Every other file this turn changed stays exactly as it
      is.
    </p>
  </ConfirmDialog>
</div>
