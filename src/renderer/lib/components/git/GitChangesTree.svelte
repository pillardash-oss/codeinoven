<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMerge from '@pdslng/cio-icon/CioMerge.svelte'
  import Switch from '../ui/Switch.svelte'
  import { ContextMenu } from 'bits-ui'
  import type { GitDiff, GitFileChange, TurnCheckpointFileDiff } from '$shared/types'
  import {
    buildChangeTree,
    compressDirChain,
    dirExpansionKey,
    filesForNode,
    pathsForNode,
    sortTreeDirs,
    type GitChangeTreeNode
  } from '$lib/git-changes-tree'
  import FileDiffView from '../files/DeferredFileDiffView.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

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
    onOpenDirectory: (path: string) => void
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
    onOpenDirectory,
    onIgnorePaths,
    onDiscardPaths,
    onResolveConflict
  }: Props = $props()

  /** Which folder rows are open. Keyed by section as well as path, so one
   *  section's fold never moves another's (see `dirExpansionKey`). */
  let expandedDirs = $state<Record<string, boolean>>({})

  function toggleDir(key: string): void {
    expandedDirs = { ...expandedDirs, [key]: !(expandedDirs[key] ?? false) }
  }

  function onToggleSelectDir(node: GitChangeTreeNode, additive: boolean): void {
    const paths = pathsForNode(node)
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

{#snippet dirActions(node: GitChangeTreeNode)}
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onOpenDirectory(node.path)}
  >
    <CioFolder size={12} class="text-warning" />
    Open directory
  </ContextMenu.Item>
  <ContextMenu.Separator class="my-1 h-px bg-border" />
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onStagePaths(pathsForNode(node), false)}
  >
    <CioCheck size={12} class="text-success" />
    Stage all
  </ContextMenu.Item>
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onStagePaths(pathsForNode(node), true)}
  >
    <span class="inline-block w-3 text-center text-[0.625rem] text-danger">−</span>
    Unstage all
  </ContextMenu.Item>
  <ContextMenu.Separator class="my-1 h-px bg-border" />
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onStashPaths(pathsForNode(node))}
  >
    <span class="inline-block w-3 text-center text-[0.625rem]">↓</span>
    Stash directory…
  </ContextMenu.Item>
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
    onSelect={() => onIgnorePaths([node.path])}
  >
    <span class="inline-block w-3 text-center text-[0.625rem]">⊘</span>
    Add directory to gitignore
  </ContextMenu.Item>
  <ContextMenu.Item
    class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated"
    onSelect={() => onDiscardPaths(pathsForNode(node))}
  >
    <span class="inline-block w-3 text-center text-[0.625rem]">⌫</span>
    Discard changes
  </ContextMenu.Item>
{/snippet}

{#snippet fileActions(change: GitFileChange)}
  {#if change.status === 'conflicted'}
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onResolveConflict?.(change.path)}
    >
      <CioMerge size={12} class="text-warning" />
      Resolve conflict…
    </ContextMenu.Item>
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onOpenInEditor(change.path)}
    >
      <span class="inline-block w-3 text-center text-[0.625rem]">✎</span>
      Open in editor
    </ContextMenu.Item>
  {:else}
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onToggleStage(change)}
    >
      {#if change.staged}
        <span class="inline-block w-3 text-center text-[0.625rem] text-danger">−</span>
        Unstage file
      {:else}
        <CioCheck size={12} class="text-success" />
        Stage file
      {/if}
    </ContextMenu.Item>
    <ContextMenu.Separator class="my-1 h-px bg-border" />
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onStashPaths([change.path])}
    >
      <span class="inline-block w-3 text-center text-[0.625rem]">↓</span>
      Stash file…
    </ContextMenu.Item>
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onOpenInEditor(change.path)}
    >
      <span class="inline-block w-3 text-center text-[0.625rem]">✎</span>
      Open
    </ContextMenu.Item>
    <ContextMenu.Separator class="my-1 h-px bg-border" />
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
      onSelect={() => onIgnorePaths([change.path])}
    >
      <span class="inline-block w-3 text-center text-[0.625rem]">⊘</span>
      Add to gitignore
    </ContextMenu.Item>
    <ContextMenu.Item
      class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated"
      onSelect={() => onDiscardPaths([change.path])}
    >
      <span class="inline-block w-3 text-center text-[0.625rem]">⌫</span>
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
          'group flex h-7 w-full cursor-pointer items-center gap-1.5 pr-1.5 text-left transition-colors',
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
          if (keymapState.matches('git-toggle-diff', e)) {
            if (change.status === 'conflicted') onResolveConflict?.(change.path)
            else onToggleDiff(change)
          }
        }}
      >
        {#if change.status !== 'conflicted'}
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
              checked={selectedPaths[change.path]}
              onchange={() => onToggleSelect(change, true)}
              title={selectedPaths[change.path]
                ? `Deselect ${change.path}`
                : `Select ${change.path}`}
              aria-label={selectedPaths[change.path]
                ? `Deselect ${change.path}`
                : `Select ${change.path}`}
              activeClass="border-primary bg-primary"
            />
          </span>
        {/if}
        <span
          class={[
            'w-4 shrink-0 text-center font-mono text-[0.625rem] font-semibold',
            statusColor(change)
          ]}
        >
          {statusLetter(change)}
        </span>
        <FileTypeIcon path={change.path} size={13} class="shrink-0" />
        <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">
          {change.path.split('/').pop()}
        </span>
        {#if diffs[key] && !diffs[key].binary}
          <span class="shrink-0 font-mono text-[0.5625rem] tabular-nums text-success">
            +{diffs[key].additions}
          </span>
          <span class="shrink-0 font-mono text-[0.5625rem] tabular-nums text-danger">
            −{diffs[key].deletions}
          </span>
        {/if}
        {#if loadingDiff[key]}
          <span class="shrink-0 text-[0.5625rem] text-dimmed">…</span>
        {:else if expanded[key]}
          <CioChevronDown size={12} class="shrink-0 text-dimmed" />
        {:else}
          <CioForward size={12} class="shrink-0 text-dimmed" />
        {/if}
      </div>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="z-50 min-w-44 overflow-hidden border border-border bg-surface p-1 shadow-xl"
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
        <p class="px-2 py-3 text-[0.625rem] text-dimmed">Loading diff…</p>
      {:else if diffErrors[key]}
        <p class="px-2 py-3 text-[0.625rem] text-danger" role="alert">{diffErrors[key]}</p>
      {:else if viewDiff}
        <FileDiffView diff={viewDiff} maxHeight="18rem" />
        {#if viewDiff.truncated}
          <p class="border-t border-border px-2 py-1 text-[0.5625rem] text-dimmed">
            Diff truncated to a bounded preview
          </p>
        {/if}
      {:else}
        <p class="px-2 py-3 text-[0.625rem] text-dimmed">No diff available.</p>
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet dirRow(node: GitChangeTreeNode, depth: number, label: string, sectionKey: string)}
  {@const stateKey = dirExpansionKey(sectionKey, node.path)}
  {@const isOpen = expandedDirs[stateKey] ?? false}
  {@const indent = 3 + depth * 2}
  {@const dirFiles = filesForNode(node)}
  {@const dirSelected =
    dirFiles.every((change) => selectedPaths[change.path]) && dirFiles.length > 0}
  <ContextMenu.Root>
    <ContextMenu.Trigger
      class="block w-full"
      aria-label={`Actions for ${label}/`}
      title={`Actions for ${label}/`}
    >
      <button
        type="button"
        class={[
          'flex h-7 w-full cursor-pointer items-center gap-1.5 px-2 text-left transition-colors',
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
          toggleDir(stateKey)
        }}
      >
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
            checked={dirSelected}
            onchange={() => onToggleSelectDir(node, true)}
            title={dirSelected ? `Deselect ${label}/` : `Select ${label}/`}
            aria-label={dirSelected ? `Deselect ${label}/` : `Select ${label}/`}
            activeClass="border-primary bg-primary"
          />
        </span>
        {#if isOpen}
          <CioChevronDown size={12} class="shrink-0 text-dimmed" />
          <CioFolderOpen size={13} class="shrink-0 text-warning" />
        {:else}
          <CioForward size={12} class="shrink-0 text-dimmed" />
          <CioFolder size={13} class="shrink-0 text-warning" />
        {/if}
        <!--
          The chain a folded row names (`apps/application/src/lib`) is one path,
          so it is written as one: the separators are dimmed only, never removed,
          because `/` is what makes it a path rather than one folder with slashes
          in its name.
        -->
        <span class="min-w-0 flex-1 truncate text-[0.625rem] font-medium text-foreground">
          {#each label.split('/') as segment, segmentIndex (segmentIndex)}
            {#if segmentIndex > 0}<span class="text-dimmed">/</span>{/if}{segment}
          {/each}
        </span>
        <span class="shrink-0 text-[0.5625rem] tabular-nums text-dimmed">
          {filesForNode(node).length}
        </span>
      </button>
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content
        class="z-50 min-w-44 overflow-hidden border border-border bg-surface p-1 shadow-xl"
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
    {#each sortTreeDirs(node.dirs) as subdir (subdir.path)}
      {@const branch = compressDirChain(subdir)}
      {@render dirRow(branch.node, depth + 1, branch.label, sectionKey)}
    {/each}
  {/if}
{/snippet}

{#each sections as section (section.title)}
  {@const tree = buildChangeTree(section.files)}
  {@const isConflicts = section.title === 'Conflicts'}
  {@const sectionAllSelected =
    section.files.length > 0 && section.files.every((f) => selectedPaths[f.path])}
  <div class="overflow-hidden border border-border bg-surface">
    <div class="flex items-center gap-1.5 bg-elevated/50 px-2.5 py-1">
      {#if !isConflicts}
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
            checked={sectionAllSelected}
            onchange={() => onToggleSection(section.files)}
            title={sectionAllSelected
              ? `Deselect all ${section.files.length} files in ${section.title}`
              : `Select all ${section.files.length} files in ${section.title}`}
            aria-label={sectionAllSelected
              ? `Deselect all ${section.files.length} files in ${section.title}`
              : `Select all ${section.files.length} files in ${section.title}`}
            activeClass="border-primary bg-primary"
          />
        </span>
      {/if}
      <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
        {section.title}
      </span>
      <span class="text-[0.5rem] tabular-nums text-dimmed">{section.files.length}</span>
    </div>

    {#if tree.dirs.size > 0 || tree.files.length > 0}
      <div class="py-1">
        {#each sortTreeDirs(tree.dirs) as dir (dir.path)}
          {@const branch = compressDirChain(dir)}
          {@render dirRow(branch.node, 0, branch.label, section.title)}
        {/each}
        {#each tree.files as change (change.path)}
          {@render fileRow(change)}
        {/each}
      </div>
    {/if}
  </div>
{/each}
