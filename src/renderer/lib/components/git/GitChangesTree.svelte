<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronsDown from '@pdslng/cio-icon/CioChevronsDown.svelte'
  import CioChevronsUp from '@pdslng/cio-icon/CioChevronsUp.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioMerge from '@pdslng/cio-icon/CioMerge.svelte'
  import Switch from '../ui/Switch.svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'
  import type { GitDiff, GitFileChange, TurnCheckpointFileDiff } from '$shared/types'
  import {
    buildChangeTree,
    compressDirChain,
    dirExpansionKey,
    filesForNode,
    pathsForNode,
    splitChangePath,
    subtreeDirKeys,
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
    /**
     * Which folder rows are open, keyed by section and path.
     *
     * The panel's changes controller owns it so a search result can open the way
     * to the file it found, and so the folds survive a switch between the list
     * and the tree.
     */
    expandedDirs?: Record<string, boolean>
    /** Measures a section body's content height, supplied by the column that
     *  sizes the sections. */
    measureCard?: Attachment<HTMLElement>
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
    onResolveConflict,
    expandedDirs = $bindable({}),
    measureCard = () => {}
  }: Props = $props()

  /**
   * The guide columns a row at this depth draws, one per ancestor.
   *
   * Indentation alone leaves a deep file floating under nothing; a hairline per
   * level is what makes a tree read as a tree, and drawing it per row (rather
   * than a background) keeps it honest when a row is selected or hovered.
   */
  function guideLevels(depth: number): number[] {
    return Array.from({ length: depth }, (_, index) => index)
  }

  /** The width the toggle occupies, so a conflicted row without one still lines
   *  its name up with every other row. */
  const SWITCH_COLUMN = 'w-7'

  function toggleDir(key: string): void {
    expandedDirs = { ...expandedDirs, [key]: !(expandedDirs[key] ?? false) }
  }

  /** Open or fold a folder and everything under it, from that level down. */
  function toggleSubtree(node: GitChangeTreeNode, sectionKey: string, open: boolean): void {
    const next = { ...expandedDirs }
    for (const key of subtreeDirKeys(node, sectionKey)) next[key] = open
    expandedDirs = next
  }

  /** Whether anything at or under this folder is open, which decides whether the
   *  control offers "expand all" or "fold all". */
  function subtreeHasOpen(node: GitChangeTreeNode, sectionKey: string): boolean {
    return subtreeDirKeys(node, sectionKey).some((key) => expandedDirs[key] === true)
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

{#snippet fileRow(change: GitFileChange, depth: number)}
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
          'group flex h-7 w-full cursor-pointer items-center gap-1.5 pl-1 pr-1.5 text-left transition-colors',
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
        {:else}
          <span class="{SWITCH_COLUMN} shrink-0" aria-hidden="true"></span>
        {/if}
        {#each guideLevels(depth) as level (level)}
          <span class="h-7 w-3 shrink-0 border-l border-border" aria-hidden="true"></span>
        {/each}
        <span
          class={[
            'w-4 shrink-0 text-center font-mono text-[0.625rem] font-semibold',
            statusColor(change)
          ]}
        >
          {statusLetter(change)}
        </span>
        <FileTypeIcon path={change.path} size={13} class="shrink-0" />
        <!-- Inside the tree the folders are the rows above, so the file row is
             its name alone, in the same weight a folder row uses. -->
        <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-foreground">
          {splitChangePath(change.path).name}
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
  {@const dirFiles = filesForNode(node)}
  {@const dirSelected =
    dirFiles.every((change) => selectedPaths[change.path]) && dirFiles.length > 0}
  <ContextMenu.Root>
    <ContextMenu.Trigger
      class="block w-full"
      aria-label={`Actions for ${label}/`}
      title={`Actions for ${label}/`}
    >
      <!--
        A div with the button role, not a button element: the row contains the
        selection Switch and the subtree control, and a button inside a button is
        invalid markup that browsers resolve by dropping one of them.
      -->
      <div
        role="button"
        tabindex="0"
        class={[
          'flex h-7 w-full cursor-pointer items-center gap-1.5 pl-1 pr-2 text-left transition-colors',
          dirSelected ? 'bg-primary/10' : 'hover:bg-elevated/50'
        ]}
        aria-expanded={isOpen}
        aria-label={`${label}/`}
        onclick={(event: MouseEvent) => {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault()
            onToggleSelectDir(node, true)
            return
          }
          toggleDir(stateKey)
        }}
        onkeydown={(event: KeyboardEvent) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
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
        {#each guideLevels(depth) as level (level)}
          <span class="h-7 w-3 shrink-0 border-l border-border" aria-hidden="true"></span>
        {/each}
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
        {#if node.dirs.size > 0}
          {@const anyOpen = subtreeHasOpen(node, sectionKey)}
          <button
            type="button"
            class={[
              'flex h-5 w-5 shrink-0 items-center justify-center transition-colors hover:bg-elevated hover:text-foreground',
              anyOpen ? 'text-foreground' : 'text-dimmed'
            ]}
            title={anyOpen ? `Fold everything under ${label}` : `Expand everything under ${label}`}
            aria-label={anyOpen
              ? `Fold everything under ${label}`
              : `Expand everything under ${label}`}
            onclick={(event: MouseEvent) => {
              event.stopPropagation()
              event.preventDefault()
              toggleSubtree(node, sectionKey, !anyOpen)
            }}
          >
            {#if anyOpen}
              <CioChevronsUp size={11} />
            {:else}
              <CioChevronsDown size={11} />
            {/if}
          </button>
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
        {@render dirActions(node)}
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>

  {#if isOpen}
    {#each node.files as change (change.path)}
      {@render fileRow(change, depth + 1)}
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
  <div
    class="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-surface"
    data-card-title={section.title}
  >
    <!-- The header keeps the row's own gutter so the section toggle sits on the
         same column as every switch below it, and the count ends the line. -->
    <div class="flex items-center gap-1.5 bg-elevated/50 py-1 pl-1 pr-2">
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
      <span
        class="ml-auto text-[0.5rem] tabular-nums text-dimmed"
        title={`${String(section.files.length)} files in ${section.title}`}
        >{section.files.length}</span
      >
    </div>

    {#if tree.dirs.size > 0 || tree.files.length > 0}
      <!-- The body is the part that scrolls when the section is taller than its
           share of the column; the header above it stays put. -->
      <div
        class="min-h-0 overflow-y-auto py-1"
        data-card-body={section.title}
        {@attach measureCard}
      >
        {#each sortTreeDirs(tree.dirs) as dir (dir.path)}
          {@const branch = compressDirChain(dir)}
          {@render dirRow(branch.node, 0, branch.label, section.title)}
        {/each}
        {#each tree.files as change (change.path)}
          {@render fileRow(change, 0)}
        {/each}
      </div>
    {/if}
  </div>
{/each}
