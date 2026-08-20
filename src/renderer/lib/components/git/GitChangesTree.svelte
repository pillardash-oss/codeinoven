<script lang="ts">
  import { Check, ChevronDown, ChevronRight, Folder, FolderOpen, GitMerge } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import type { GitDiff, GitFileChange, TurnCheckpointFileDiff } from '$shared/types'
  import FileDiffView from '../files/FileDiffView.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'

  interface Props {
    sections: Array<{ title: string; files: GitFileChange[] }>
    diffs: Record<string, GitDiff>
    expanded: Record<string, boolean>
    loadingDiff: Record<string, boolean>
    diffErrors: Record<string, string | null>
    selectedPaths: Record<string, boolean>
    onToggleDiff: (change: GitFileChange) => void
    onToggleStage: (change: GitFileChange) => void
    onToggleSelect: (change: GitFileChange, additive: boolean) => void
    onStagePaths: (paths: string[], staged: boolean) => void
    onStashPaths: (paths: string[]) => void
    onOpenInEditor: (path: string) => void
    onIgnorePaths: (paths: string[]) => void
    onDiscardPaths: (paths: string[]) => void
    /** Opens the dedicated conflict-resolution panel for a conflicted file. */
    onResolveConflict?: (path: string) => void
  }

  let {
    sections,
    diffs,
    expanded,
    loadingDiff,
    diffErrors,
    selectedPaths = $bindable({} as Record<string, boolean>),
    onToggleDiff,
    onToggleStage,
    onToggleSelect,
    onStagePaths,
    onStashPaths,
    onOpenInEditor,
    onIgnorePaths,
    onDiscardPaths,
    onResolveConflict
  }: Props = $props()

  interface TreeNode {
    name: string
    path: string
    dirs: Map<string, TreeNode>
    files: GitFileChange[]
  }

  let expandedDirs = $state<Record<string, boolean>>({})

  function buildTree(sectionFiles: GitFileChange[]): TreeNode {
    const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }
    for (const change of sectionFiles) {
      const segments = change.path.split('/')
      let node = root
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i] ?? ''
        let child = node.dirs.get(seg)
        if (!child) {
          child = {
            name: seg,
            path: segments.slice(0, i + 1).join('/'),
            dirs: new Map(),
            files: []
          }
          node.dirs.set(seg, child)
        }
        node = child
      }
      node.files.push(change)
    }
    return root
  }

  function sortDirs(dirs: Map<string, TreeNode>): TreeNode[] {
    return [...dirs.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  function filesFor(node: TreeNode): GitFileChange[] {
    const files = [...node.files]
    for (const child of node.dirs.values()) files.push(...filesFor(child))
    return files
  }

  function allPathsFor(node: TreeNode): string[] {
    return filesFor(node).map((change) => change.path)
  }

  function toggleDir(path: string): void {
    expandedDirs = { ...expandedDirs, [path]: !(expandedDirs[path] ?? false) }
  }

  function onToggleSelectDir(node: TreeNode, additive: boolean): void {
    const paths = allPathsFor(node)
    const allSelected = paths.length > 0 && paths.every((path) => selectedPaths[path])
    const remove = additive && allSelected
    const next = { ...selectedPaths }
    for (const path of paths) {
      if (remove) {
        delete next[path]
      } else {
        next[path] = true
      }
    }
    selectedPaths = next
  }

  function onToggleSection(sectionFiles: GitFileChange[]): void {
    const allSelected = sectionFiles.length > 0 && sectionFiles.every((f) => selectedPaths[f.path])
    const next = { ...selectedPaths }
    for (const file of sectionFiles) {
      if (allSelected) {
        delete next[file.path]
      } else {
        next[file.path] = true
      }
    }
    selectedPaths = next
  }

  const statusLetter = (change: GitFileChange): string =>
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

  const statusColor = (change: GitFileChange): string =>
    change.status === 'added'
      ? 'text-success'
      : change.status === 'deleted'
        ? 'text-danger'
        : 'text-warning'

  function fileKey(change: GitFileChange): string {
    return `${change.staged ? 's:' : 'w:'}${change.path}`
  }

  function viewDiffFor(change: GitFileChange, diff: GitDiff | null): TurnCheckpointFileDiff | null {
    if (!diff) return null
    return {
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
    }
  }
</script>

{#snippet dirActions(node: TreeNode)}
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onStagePaths(allPathsFor(node), false)}
  >
    <Check size={12} class="text-success" />
    Stage all
  </ContextMenu.Item>
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onStagePaths(allPathsFor(node), true)}
  >
    <span class="inline-block w-3 text-center text-[10px] text-danger">−</span>
    Unstage all
  </ContextMenu.Item>
  <ContextMenu.Separator class="my-1 h-px bg-border" />
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onStashPaths(allPathsFor(node))}
  >
    <span class="inline-block w-3 text-center text-[10px]">↓</span>
    Stash directory…
  </ContextMenu.Item>
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onIgnorePaths([node.path])}
  >
    <span class="inline-block w-3 text-center text-[10px]">⊘</span>
    Add directory to gitignore
  </ContextMenu.Item>
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-danger outline-none data-highlighted:bg-elevated"
    onSelect={() => onDiscardPaths(allPathsFor(node))}
  >
    <span class="inline-block w-3 text-center text-[10px]">⌫</span>
    Discard changes
  </ContextMenu.Item>
{/snippet}

{#snippet fileActions(change: GitFileChange)}
  {#if change.status === 'conflicted'}
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onResolveConflict?.(change.path)}
    >
      <GitMerge size={12} class="text-warning" />
      Resolve conflict…
    </ContextMenu.Item>
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onOpenInEditor(change.path)}
    >
      <span class="inline-block w-3 text-center text-[10px]">✎</span>
      Open in editor
    </ContextMenu.Item>
  {:else}
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onToggleStage(change)}
    >
      {#if change.staged}
        <span class="inline-block w-3 text-center text-[10px] text-danger">−</span>
        Unstage file
      {:else}
        <Check size={12} class="text-success" />
        Stage file
      {/if}
    </ContextMenu.Item>
    <ContextMenu.Separator class="my-1 h-px bg-border" />
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onStashPaths([change.path])}
    >
      <span class="inline-block w-3 text-center text-[10px]">↓</span>
      Stash file…
    </ContextMenu.Item>
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onOpenInEditor(change.path)}
    >
      <span class="inline-block w-3 text-center text-[10px]">✎</span>
      Open
    </ContextMenu.Item>
    <ContextMenu.Separator class="my-1 h-px bg-border" />
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onIgnorePaths([change.path])}
    >
      <span class="inline-block w-3 text-center text-[10px]">⊘</span>
      Add to gitignore
    </ContextMenu.Item>
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-danger outline-none data-highlighted:bg-elevated"
      onSelect={() => onDiscardPaths([change.path])}
    >
      <span class="inline-block w-3 text-center text-[10px]">⌫</span>
      Discard changes
    </ContextMenu.Item>
  {/if}
{/snippet}

{#snippet fileRow(change: GitFileChange)}
  {@const key = fileKey(change)}
  {@const viewDiff = viewDiffFor(change, diffs[key] ?? null)}
  <ContextMenu.Root>
    <ContextMenu.Trigger
      class="block w-full"
      aria-label={`Actions for ${change.path}`}
      title={`Actions for ${change.path}`}
    >
      <div
        class={[
          'group flex h-8 w-full cursor-pointer items-center gap-2 pr-2 text-left transition-colors',
          selectedPaths[change.path] ? 'bg-primary/10' : 'hover:bg-elevated/50'
        ]}
        role="button"
        tabindex="0"
        onclick={(event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            onToggleSelect(change, true)
            return
          }
          if (change.status === 'conflicted') {
            onResolveConflict?.(change.path)
            return
          }
          onToggleDiff(change)
        }}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            if (change.status === 'conflicted') onResolveConflict?.(change.path)
            else onToggleDiff(change)
          }
        }}
      >
        {#if change.status !== 'conflicted'}
          <span
            role="checkbox"
            tabindex="0"
            aria-checked={selectedPaths[change.path]}
            aria-label={selectedPaths[change.path]
              ? `Deselect ${change.path}`
              : `Select ${change.path}`}
            class={[
              'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors',
              selectedPaths[change.path] ? 'border-primary bg-primary' : 'border-border bg-elevated'
            ]}
            onclick={(event: MouseEvent) => {
              event.stopPropagation()
              event.preventDefault()
              onToggleSelect(change, true)
            }}
            onkeydown={(event: KeyboardEvent) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.stopPropagation()
                event.preventDefault()
                onToggleSelect(change, true)
              }
            }}
          >
            {#if selectedPaths[change.path]}
              <Check size={9} class="text-on-primary" />
            {/if}
          </span>
        {/if}
        <span
          class={[
            'w-4 shrink-0 text-center font-mono text-[10px] font-semibold',
            statusColor(change)
          ]}
        >
          {statusLetter(change)}
        </span>
        <FileTypeIcon path={change.path} size={13} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
          {change.path.split('/').pop()}
        </span>
        {#if diffs[key] && !diffs[key].binary}
          <span class="shrink-0 font-mono text-[9px] tabular-nums text-success">
            +{diffs[key].additions}
          </span>
          <span class="shrink-0 font-mono text-[9px] tabular-nums text-danger">
            −{diffs[key].deletions}
          </span>
        {/if}
        {#if loadingDiff[key]}
          <span class="shrink-0 text-[9px] text-dimmed">…</span>
        {:else if expanded[key]}
          <ChevronDown size={12} class="shrink-0 text-dimmed" />
        {:else}
          <ChevronRight size={12} class="shrink-0 text-dimmed" />
        {/if}
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
      >
        {@render fileActions(change)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>

  {#if expanded[key]}
    <div class="border-t border-border bg-app/50 pl-7">
      {#if loadingDiff[key]}
        <p class="px-3 py-4 text-[10px] text-dimmed">Loading diff…</p>
      {:else if diffErrors[key]}
        <p class="px-3 py-4 text-[10px] text-danger" role="alert">{diffErrors[key]}</p>
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
{/snippet}

{#snippet dirRow(node: TreeNode, depth: number)}
  {@const isOpen = expandedDirs[node.path] ?? false}
  {@const indent = 3 + depth * 2}
  {@const dirFiles = filesFor(node)}
  {@const dirSelected =
    dirFiles.every((change) => selectedPaths[change.path]) && dirFiles.length > 0}
  <ContextMenu.Root>
    <ContextMenu.Trigger
      class="block w-full"
      aria-label={`Actions for ${node.path}/`}
      title={`Actions for ${node.path}/`}
    >
      <button
        type="button"
        class={[
          'flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left transition-colors',
          dirSelected ? 'bg-primary/10' : 'hover:bg-elevated/50'
        ]}
        style="padding-left: {indent}px"
        aria-expanded={isOpen}
        onclick={(event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            onToggleSelectDir(node, true)
            return
          }
          toggleDir(node.path)
        }}
      >
        <span
          role="checkbox"
          tabindex="0"
          aria-checked={dirSelected}
          aria-label={dirSelected ? `Deselect ${node.path}/` : `Select ${node.path}/`}
          class={[
            'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors',
            dirSelected ? 'border-primary bg-primary' : 'border-border bg-elevated'
          ]}
          onclick={(event: MouseEvent) => {
            event.stopPropagation()
            event.preventDefault()
            onToggleSelectDir(node, true)
          }}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              event.preventDefault()
              onToggleSelectDir(node, true)
            }
          }}
        >
          {#if dirSelected}
            <Check size={9} class="text-on-primary" />
          {/if}
        </span>
        {#if isOpen}
          <ChevronDown size={12} class="shrink-0 text-dimmed" />
          <FolderOpen size={13} class="shrink-0 text-warning" />
        {:else}
          <ChevronRight size={12} class="shrink-0 text-dimmed" />
          <Folder size={13} class="shrink-0 text-warning" />
        {/if}
        <span class="min-w-0 flex-1 truncate text-[10px] font-medium text-foreground">
          {node.name}
        </span>
        <span class="shrink-0 text-[9px] tabular-nums text-dimmed">
          {filesFor(node).length}
        </span>
      </button>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="z-50 min-w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
      >
        {@render dirActions(node)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>

  {#if isOpen}
    {#each node.files as change (change.path)}
      {@render fileRow(change)}
    {/each}
    {#each sortDirs(node.dirs) as subdir (subdir.path)}
      {@render dirRow(subdir, depth + 1)}
    {/each}
  {/if}
{/snippet}

{#each sections as section (section.title)}
  {@const tree = buildTree(section.files)}
  {@const isConflicts = section.title === 'Conflicts'}
  {@const sectionAllSelected =
    section.files.length > 0 && section.files.every((f) => selectedPaths[f.path])}
  {@const sectionSomeSelected = section.files.some((f) => selectedPaths[f.path])}
  <div class="overflow-hidden rounded-lg border border-border bg-surface">
    <div class="flex items-center gap-2 bg-elevated/50 px-3 py-1.5">
      {#if !isConflicts}
        <span
          role="checkbox"
          tabindex="0"
          aria-checked={sectionAllSelected ? 'true' : sectionSomeSelected ? 'mixed' : 'false'}
          aria-label={sectionAllSelected
            ? `Deselect all ${section.files.length} files in ${section.title}`
            : `Select all ${section.files.length} files in ${section.title}`}
          class={[
            'flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border transition-colors',
            sectionAllSelected ? 'border-primary bg-primary' : 'border-border bg-elevated'
          ]}
          onclick={(event: MouseEvent) => {
            event.stopPropagation()
            event.preventDefault()
            onToggleSection(section.files)
          }}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.stopPropagation()
              event.preventDefault()
              onToggleSection(section.files)
            }
          }}
        >
          {#if sectionAllSelected}
            <Check size={9} class="text-on-primary" />
          {:else if sectionSomeSelected}
            <span class="h-0.5 w-1.5 rounded-full bg-primary"></span>
          {/if}
        </span>
      {/if}
      <span class="text-[9px] font-semibold uppercase tracking-wide text-muted">
        {section.title}
      </span>
      <span class="text-[8px] tabular-nums text-dimmed">{section.files.length}</span>
    </div>

    {#if tree.dirs.size > 0 || tree.files.length > 0}
      <div class="py-1">
        {#each sortDirs(tree.dirs) as dir (dir.path)}
          {@render dirRow(dir, 0)}
        {/each}
        {#each tree.files as change (change.path)}
          {@render fileRow(change)}
        {/each}
      </div>
    {/if}
  </div>
{/each}
