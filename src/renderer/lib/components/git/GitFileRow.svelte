<script lang="ts">
  import type { GitDiff, GitFileChange, TurnCheckpointFileDiff } from '$shared/types'
  import { Check } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import FileDiffView from '../files/FileDiffView.svelte'
  import { ChevronDown, ChevronRight, GitMerge, Loader2 } from '@lucide/svelte'
  import Switch from '../ui/Switch.svelte'

  interface Props {
    change: GitFileChange
    diff: GitDiff | null
    loadingDiff: boolean
    error: string | null
    expanded: boolean
    selected?: boolean
    selectable?: boolean
    onToggleDiff: () => void
    onToggleStage: () => void
    onToggleSelect?: (change: GitFileChange, additive: boolean) => void
    onStash?: (path: string) => void
    onOpenInEditor?: (path: string) => void
    onIgnore?: (path: string) => void
    onDiscard?: (path: string) => void
    /** Opens the dedicated conflict-resolution panel for a conflicted file. */
    onResolveConflict?: (path: string) => void
    readonly?: boolean
    /** Overrides the label shown for the path (e.g. just the basename inside a tree). */
    displayPath?: string
  }

  let {
    change,
    diff,
    loadingDiff,
    error,
    expanded,
    selected = false,
    selectable = false,
    onToggleDiff,
    onToggleStage,
    onToggleSelect,
    onStash,
    onOpenInEditor,
    onIgnore,
    onDiscard,
    onResolveConflict,
    readonly = false,
    displayPath
  }: Props = $props()

  const hasActions = $derived(
    !readonly &&
      (onStash !== undefined ||
        onOpenInEditor !== undefined ||
        onIgnore !== undefined ||
        onDiscard !== undefined ||
        onResolveConflict !== undefined)
  )

  const letter = $derived(
    change.status === 'added'
      ? 'A'
      : change.status === 'deleted'
        ? 'D'
        : change.status === 'renamed'
          ? 'R'
          : change.status === 'untracked'
            ? '?'
            : change.status === 'conflicted'
              ? 'U'
              : 'M'
  )

  const color = $derived(
    change.status === 'added'
      ? 'text-success'
      : change.status === 'deleted'
        ? 'text-danger'
        : 'text-warning'
  )

  const viewDiff = $derived(
    diff
      ? ({
          path: diff.path,
          kind:
            change.status === 'added' || change.status === 'untracked'
              ? 'created'
              : change.status === 'deleted'
                ? 'deleted'
                : 'modified',
          binary: diff.binary,
          before: diff.before,
          after: diff.after,
          truncated: diff.truncated
        } satisfies TurnCheckpointFileDiff)
      : null
  )
</script>

<div class="overflow-hidden border-b border-border last:border-b-0">
  <ContextMenu.Root>
    <ContextMenu.Trigger
      class="block w-full"
      disabled={!hasActions}
      aria-label={hasActions ? `Actions for ${change.path}` : undefined}
      title={hasActions ? `Actions for ${change.path}` : undefined}
    >
      <div class="group flex min-h-9 items-center pr-1.5">
        <button
          type="button"
          class={[
            'flex min-h-9 min-w-0 flex-1 items-center gap-2 px-3 text-left transition-colors',
            selected ? 'bg-primary/10' : 'hover:bg-elevated/50'
          ]}
          title={change.status === 'conflicted' && onResolveConflict
            ? `Resolve conflict in ${change.path}`
            : expanded
              ? `Collapse diff for ${change.path}`
              : `Show diff for ${change.path}`}
          aria-expanded={expanded}
          aria-pressed={selectable ? selected : undefined}
          onclick={(event: MouseEvent) => {
            if (selectable && onToggleSelect && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              onToggleSelect(change, true)
              return
            }
            if (change.status === 'conflicted' && onResolveConflict) {
              onResolveConflict(change.path)
              return
            }
            onToggleDiff()
          }}
        >
          {#if selectable}
            <span
              class="shrink-0"
              role="presentation"
              onclick={(event: MouseEvent) => {
                event.stopPropagation()
                event.preventDefault()
              }}
              onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
            >
              <Switch
                checked={selected}
                onchange={() => onToggleSelect?.(change, true)}
                title={selected ? `Deselect ${change.path}` : `Select ${change.path}`}
                aria-label={selected ? `Deselect ${change.path}` : `Select ${change.path}`}
                activeClass="border-primary bg-primary"
              />
            </span>
          {/if}
          <span class={['w-4 shrink-0 text-center font-mono text-[10px] font-semibold', color]}>
            {letter}
          </span>
          <FileTypeIcon path={change.path} size={13} />
          <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted"
            >{displayPath ?? change.path}</span
          >
          {#if change.oldPath}
            <span class="shrink-0 text-[9px] text-dimmed">from {change.oldPath}</span>
          {/if}
          {#if diff && !diff.binary}
            <span class="shrink-0 font-mono text-[10px] tabular-nums text-success">
              +{diff.additions}
            </span>
            <span class="shrink-0 font-mono text-[10px] tabular-nums text-danger">
              −{diff.deletions}
            </span>
          {:else if diff?.binary}
            <span class="shrink-0 text-[9px] text-dimmed">binary</span>
          {/if}
          {#if loadingDiff}
            <Loader2 size={11} class="shrink-0 animate-spin text-dimmed" />
          {:else if expanded}
            <ChevronDown size={12} class="shrink-0 text-dimmed" />
          {:else}
            <ChevronRight size={12} class="shrink-0 text-dimmed" />
          {/if}
        </button>
        {#if !readonly}
          {#if change.status === 'conflicted' && onResolveConflict}
            <button
              type="button"
              class="shrink-0 rounded px-2 py-1 text-[10px] font-medium text-warning transition-colors hover:bg-warning/10"
              aria-label={`Resolve conflict in ${change.path}`}
              title={`Resolve conflict in ${change.path}`}
              onclick={() => onResolveConflict(change.path)}
            >
              Resolve
            </button>
          {:else}
            <button
              type="button"
              class={[
                'shrink-0 rounded px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-40',
                change.staged
                  ? 'text-danger hover:bg-danger/10'
                  : 'text-muted hover:bg-elevated hover:text-foreground'
              ]}
              disabled={change.status === 'conflicted'}
              aria-label={change.staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
              title={change.staged ? `Unstage ${change.path}` : `Stage ${change.path}`}
              onclick={onToggleStage}
            >
              {change.staged ? 'Unstage' : 'Stage'}
            </button>
          {/if}
        {/if}
      </div>
    </ContextMenu.Trigger>

    {#if hasActions}
      <ContextMenu.Portal>
        <ContextMenu.Content
          class="z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionPadding={8}
        >
          {#if change.status === 'conflicted'}
            {#if onResolveConflict}
              <ContextMenu.Item
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => onResolveConflict?.(change.path)}
              >
                <GitMerge size={12} class="text-warning" />
                Resolve conflict…
              </ContextMenu.Item>
            {/if}
            {#if onOpenInEditor}
              <ContextMenu.Item
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => onOpenInEditor?.(change.path)}
              >
                <span class="inline-block w-3 text-center text-[10px]">✎</span>
                Open in editor
              </ContextMenu.Item>
            {/if}
          {:else}
            <ContextMenu.Item
              class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
              onSelect={() => onToggleStage()}
            >
              {#if change.staged}
                <span class="inline-block w-3 text-center text-[10px] text-danger">−</span>
                Unstage file
              {:else}
                <Check size={12} class="text-success" />
                Stage file
              {/if}
            </ContextMenu.Item>
            {#if onStash}
              <ContextMenu.Separator class="my-1 h-px bg-border" />
              <ContextMenu.Item
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => onStash?.(change.path)}
              >
                <span class="inline-block w-3 text-center text-[10px]">↓</span>
                Stash file…
              </ContextMenu.Item>
            {/if}
            {#if onOpenInEditor}
              <ContextMenu.Item
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
                onSelect={() => onOpenInEditor?.(change.path)}
              >
                <span class="inline-block w-3 text-center text-[10px]">✎</span>
                Open
              </ContextMenu.Item>
            {/if}
            {#if onIgnore || onDiscard}
              <ContextMenu.Separator class="my-1 h-px bg-border" />
              {#if onIgnore}
                <ContextMenu.Item
                  class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
                  onSelect={() => onIgnore?.(change.path)}
                >
                  <span class="inline-block w-3 text-center text-[10px]">⊘</span>
                  Add to gitignore
                </ContextMenu.Item>
              {/if}
              {#if onDiscard}
                <ContextMenu.Item
                  class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-danger outline-none data-highlighted:bg-elevated"
                  onSelect={() => onDiscard?.(change.path)}
                >
                  <span class="inline-block w-3 text-center text-[10px]">⌫</span>
                  Discard changes
                </ContextMenu.Item>
              {/if}
            {/if}
          {/if}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    {/if}
  </ContextMenu.Root>
  {#if expanded}
    <div class="border-t border-border bg-app/50">
      {#if loadingDiff}
        <div class="flex items-center gap-2 px-3 py-4 text-dimmed">
          <Loader2 size={12} class="animate-spin" />
          <span class="text-[10px]">Loading diff…</span>
        </div>
      {:else if error}
        <p class="px-3 py-4 text-[10px] text-danger" role="alert">{error}</p>
      {:else if viewDiff}
        <FileDiffView diff={viewDiff} maxHeight="18rem" />
        {#if viewDiff.truncated}
          <p class="border-t border-border px-3 py-1 text-[9px] text-dimmed">
            Diff truncated to a bounded preview
          </p>
        {/if}
      {:else}
        <p class="px-3 py-4 text-[10px] text-dimmed">No diff available.</p>
      {/if}
    </div>
  {/if}
</div>
