<script lang="ts">
  import {
    ChevronDown,
    ChevronRight,
    FolderTree,
    GripVertical,
    Plus,
    TriangleAlert
  } from '@lucide/svelte'
  import StageContainer from './StageContainer.svelte'
  import ScopeActionsMenu from '../shared/ScopeActionsMenu.svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { scopeState, STAGE_ORDER, type ThreadStage } from '$lib/stores/scope.svelte'
  import { type ScopeBucket, type Thread } from '$shared/types'

  interface Props {
    bucket: ScopeBucket
    fill?: boolean
    selectedThreadId: string | null
    onToggle: () => void
    onToggleSlice: (stage: ThreadStage) => void
    onEditBucket: () => void
    onDeleteBucket: () => void
    onMoveBucket: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    onCreateThread: () => void
    onOpen: (thread: Thread) => void
    onRename: (thread: Thread, newName: string) => Promise<void>
    onTogglePin: (thread: Thread) => void
    onDelete: (thread: Thread) => Promise<void>
    onFork: (thread: Thread) => void
    onMoveThread: (threadId: string, bucketId: string) => void
    onReorderThread: (
      stage: ThreadStage,
      draggedId: string,
      targetId: string,
      position: 'before' | 'after'
    ) => void
    /** Lifecycle callbacks surfaced through the scope actions menu. */
    onArchive?: () => void
    onRestore?: () => void
    onCreateWorktree?: () => void
    onAdoptWorktree?: () => void
    onRetrySetup?: () => void
    onRepairWorktree?: () => void
    onDetach?: () => void
    onRemoveWorktree?: () => void
    onDeleteBranch?: () => void
  }

  let {
    bucket,
    fill = false,
    selectedThreadId,
    onToggle,
    onToggleSlice,
    onEditBucket,
    onDeleteBucket,
    onMoveBucket,
    onCreateThread,
    onOpen,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onMoveThread,
    onReorderThread,
    onArchive,
    onRestore,
    onCreateWorktree,
    onAdoptWorktree,
    onRetrySetup,
    onRepairWorktree,
    onDetach,
    onRemoveWorktree,
    onDeleteBranch
  }: Props = $props()

  let scopeDropPosition = $state<'before' | 'after' | null>(null)
  let threadCount = $derived(
    scopeState.currentProjectThreads.filter(
      (thread) => scopeState.bucketForThread(thread) === bucket.id
    ).length
  )

  const REPAIRABLE_HEALTH_CATEGORIES = new Set([
    'missing',
    'unregistered',
    'locked',
    'prunable',
    'branch-mismatch',
    'path-mismatch'
  ])

  let healthKey = $derived(`${scopeState.activeProjectId ?? ''}:${bucket.id}`)
  let health = $derived(scopeState.healthByTarget.get(healthKey))
  let unhealthy = $derived(health !== undefined && health.category !== 'healthy')
  let repairable = $derived(
    unhealthy && health !== undefined && REPAIRABLE_HEALTH_CATEGORIES.has(health.category)
  )
  let healthDetail = $derived(
    health === undefined ? '' : (health.detail ?? `Worktree is ${health.category}`)
  )

  let visibleStages = $derived(
    STAGE_ORDER.filter(
      (stage) =>
        stage === 'pinned' || stage === 'todo' || scopeState.threadsFor(bucket.id, stage).length > 0
    )
  )

  const SCOPE_DRAG_TYPE = 'application/x-codeinoven-scope-id'

  function startScopeDrag(event: DragEvent): void {
    event.stopPropagation()
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(SCOPE_DRAG_TYPE, bucket.id)
  }

  function handleScopeDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(SCOPE_DRAG_TYPE)) return
    event.preventDefault()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    scopeDropPosition = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after'
    event.dataTransfer.dropEffect = 'move'
  }

  function handleScopeDrop(event: DragEvent): void {
    const draggedId = event.dataTransfer?.getData(SCOPE_DRAG_TYPE)
    if (!draggedId || !scopeDropPosition) return
    event.preventDefault()
    event.stopPropagation()
    onMoveBucket(draggedId, bucket.id, scopeDropPosition)
    scopeDropPosition = null
  }
</script>

<section
  class="relative flex w-full min-w-0 flex-col rounded-xl border bg-surface {bucket.collapsed
    ? 'h-10'
    : fill
      ? 'h-full'
      : 'h-120'} {scopeDropPosition ? 'ring-2 ring-primary/30' : ''}"
  style:border-color={bucket.color}
  aria-labelledby="scope-bucket-{bucket.id}"
  ondragover={handleScopeDragOver}
  ondragleave={() => (scopeDropPosition = null)}
  ondrop={handleScopeDrop}
>
  <div class="sticky top-0 z-40 flex h-10 shrink-0 items-center rounded-t-xl bg-surface px-3">
    <button
      class="mr-1 flex h-7 w-5 shrink-0 cursor-grab items-center justify-center rounded-md text-dimmed hover:bg-elevated hover:text-foreground active:cursor-grabbing"
      aria-label="Move {bucket.name}"
      title="Drag to move scope"
      draggable="true"
      ondragstart={startScopeDrag}
      ondragend={() => (scopeDropPosition = null)}
    >
      <GripVertical size={13} />
    </button>
    <button
      class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-elevated"
      aria-expanded={!bucket.collapsed}
      title="{bucket.collapsed ? 'Expand' : 'Collapse'} {bucket.name}"
      onclick={onToggle}
    >
      {#if bucket.collapsed}
        <ChevronRight size={14} class="shrink-0 text-dimmed" />
      {:else}
        <ChevronDown size={14} class="shrink-0 text-dimmed" />
      {/if}
      {#if bucket.iconType}
        <img
          src={getIconSvgDataUrl(bucket.iconType, bucket.color ?? pickColorForSeed(bucket.id))}
          alt=""
          class="h-4 w-4 shrink-0 object-contain"
          draggable="false"
        />
      {:else if bucket.color}
        <img
          src={generateInitialsIconSvg(bucket.name, bucket.color)}
          alt=""
          class="h-4 w-4 shrink-0 object-contain"
          draggable="false"
        />
      {/if}
      {#if bucket.root.kind === 'worktree'}
        <span
          class="flex shrink-0 items-center gap-1 rounded bg-warning/10 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warning"
          title="Managed Git worktree scope on {bucket.root.branch}"
        >
          <FolderTree size={9} />
          Worktree
        </span>
      {/if}
      <h2 id="scope-bucket-{bucket.id}" class="truncate text-xs font-semibold text-foreground">
        {bucket.name}
      </h2>
      {#if bucket.root.kind === 'worktree'}
        <span
          class="shrink-0 rounded border border-overlay bg-overlay px-1 py-0.5 font-mono text-[9px] leading-none text-muted"
          title="Managed Git worktree scope on {bucket.root.branch}"
        >
          {bucket.root.branch}
        </span>
      {/if}
      <span class="text-[10px] tabular-nums text-dimmed">{threadCount}</span>
    </button>

    {#if unhealthy}
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-warning transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Worktree problem in {bucket.name}: {healthDetail}. {repairable
          ? 'Click to repair.'
          : ''}"
        title="{healthDetail}{repairable ? ' Click to repair.' : ''}"
        onclick={() => {
          if (repairable) onRepairWorktree?.()
        }}
      >
        <TriangleAlert size={13} />
      </button>
    {/if}

    <button
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="New thread in {bucket.name}"
      title="New thread in {bucket.name}"
      onclick={onCreateThread}
    >
      <Plus size={14} />
    </button>

    <ScopeActionsMenu
      {bucket}
      onEdit={onEditBucket}
      onDelete={onDeleteBucket}
      {onArchive}
      {onRestore}
      {onCreateWorktree}
      {onAdoptWorktree}
      {onRetrySetup}
      {onRepairWorktree}
      hasRepairableIssue={repairable}
      {onDetach}
      {onRemoveWorktree}
      {onDeleteBranch}
    />
  </div>

  {#if !bucket.collapsed}
    <div class="min-h-0 flex-1 px-2 pb-2">
      <div class="flex h-full min-w-0 gap-2">
        {#each visibleStages as stage (stage)}
          <StageContainer
            bucketId={bucket.id}
            {stage}
            threads={scopeState.threadsFor(bucket.id, stage)}
            collapsed={bucket.collapsedSlices.includes(stage)}
            {selectedThreadId}
            onToggle={() => onToggleSlice(stage)}
            {onOpen}
            {onRename}
            {onTogglePin}
            {onDelete}
            {onFork}
            {onMoveThread}
            onReorderThread={(draggedId, targetId, position) =>
              onReorderThread(stage, draggedId, targetId, position)}
          />
        {/each}
      </div>
    </div>
  {/if}
</section>
