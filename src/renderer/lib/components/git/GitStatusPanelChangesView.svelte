<script lang="ts">
  import { formatChangeSummary } from '$shared/change-breakdown'
  import { waterFillHeights } from '$lib/git-changes-layout'
  import type { Attachment } from 'svelte/attachments'
  import { RunChangesState } from '../threads/run-changes-state.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { ContextMenu } from 'bits-ui'
  import type {
    GitCommitInfo,
    GitDiff,
    GitFileChange,
    GitRestoreTarget,
    GitStatus
  } from '$shared/types'
  import GitChangesTree from './GitChangesTree.svelte'
  import GitFileRow from './GitFileRow.svelte'
  import Switch from '../ui/Switch.svelte'
  import { fileDiffKey, sortCommitDirs, type CommitTreeNode } from './git-status-panel-format'

  interface Props {
    selectedCommit: GitCommitInfo | null
    status: GitStatus | null
    changes: GitFileChange[]
    conflictSections: Array<{ title: string; files: GitFileChange[] }>
    stagedSections: Array<{ title: string; files: GitFileChange[] }>
    workingSections: Array<{ title: string; files: GitFileChange[] }>
    commitDiffChanges: GitFileChange[]
    commitTree: CommitTreeNode
    commitTreeCollapsedDirs: Record<string, boolean>
    changesView: 'list' | 'tree'
    loadingCommitDiff: boolean
    diffs: Record<string, GitDiff>
    expanded: Record<string, boolean>
    loadingDiff: Record<string, boolean>
    diffErrors: Record<string, string | null>
    commitDiffs: Record<string, GitDiff>
    commitExpanded: Record<string, boolean>
    loadingCommitDiffFile: Record<string, boolean>
    commitDiffErrors: Record<string, string | null>
    selectedPaths: Record<string, boolean>
    toggleDiff: (change: GitFileChange) => void
    toggleStage: (change: GitFileChange) => void
    toggleSelection: (change: GitFileChange, additive: boolean) => void
    toggleSectionSelection: (sectionFiles: GitFileChange[]) => void
    stagePathsAction: (paths: string[], staged: boolean) => void
    requestStashFor: (paths: string[]) => void
    openInEditor: (path: string) => void
    openDirectory: (path: string) => void
    ignorePathsAction: (paths: string[]) => void
    requestDiscard: (paths: string[]) => void
    routeConflictResolution: (initial?: string) => void
    restoreFromSource: (source: string, path: string, target: GitRestoreTarget) => void
    toggleCommitDiff: (change: GitFileChange) => void
    toggleCommitDir: (path: string) => void
    /** Take the given files of the open commit out of it (confirmed by the panel). */
    requestRemoveCommitChanges: (paths: string[]) => void
    /** Folder open state, owned by the panel so a search can reveal a file. */
    expandedDirs: Record<string, boolean>
  }

  let {
    selectedCommit,
    status,
    changes,
    conflictSections,
    stagedSections,
    workingSections,
    commitDiffChanges,
    commitTree,
    commitTreeCollapsedDirs,
    changesView,
    loadingCommitDiff,
    diffs,
    expanded,
    loadingDiff,
    diffErrors,
    commitDiffs,
    commitExpanded,
    loadingCommitDiffFile,
    commitDiffErrors,
    selectedPaths = $bindable(),
    toggleDiff,
    toggleStage,
    toggleSelection,
    toggleSectionSelection,
    stagePathsAction,
    requestStashFor,
    openInEditor,
    openDirectory,
    ignorePathsAction,
    requestDiscard,
    routeConflictResolution,
    restoreFromSource,
    toggleCommitDiff,
    toggleCommitDir,
    requestRemoveCommitChanges,
    expandedDirs = $bindable()
  }: Props = $props()

  // The existing summary worker batches path metadata. Rendering never waits on it.
  const breakdownState = new RunChangesState(
    () => ({ changes: selectedCommit ? commitDiffChanges : changes }),
    true
  )
  const summaryTitle = $derived(
    formatChangeSummary(
      breakdownState.summary?.breakdown,
      null,
      breakdownState.summary?.breakdown?.totalFiles ??
        (selectedCommit ? commitDiffChanges.length : changes.length)
    )
  )

  /**
   * One card per section, in the order the panel shows them: conflicts first,
   * then staged work, then what is still in the working tree.
   *
   * The column is split between these, not between the three panes they used to
   * be grouped in, because a reader looks at Unstaged and Untracked as two lists
   * and expects each of them to hold its own height.
   */
  const cards = $derived.by(() => {
    const list: Array<{ title: string; files: GitFileChange[]; conflicts: boolean }> = []
    for (const section of conflictSections)
      list.push({ title: section.title, files: section.files, conflicts: true })
    for (const section of stagedSections)
      list.push({ title: section.title, files: section.files, conflicts: false })
    for (const section of workingSections)
      list.push({ title: section.title, files: section.files, conflicts: false })
    return list
  })

  /** The column's usable height, measured, because the cards are sized from it. */
  let columnHeight = $state(0)

  /**
   * How tall each card would be with nothing limiting it, measured from its own
   * content.
   *
   * `scrollHeight` is the height the card's content asks for whether or not the
   * card is currently clipped, so a measurement taken while a section is
   * scrolled never reports the visible height instead of the real one. Expanding
   * a folder or a diff changes it, which is why the observer keeps watching
   * instead of measuring once.
   */
  let naturalHeights = $state<Record<string, number>>({})

  const measureColumn: Attachment<HTMLElement> = (element) => {
    const measure = (): void => {
      columnHeight = element.clientHeight
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }

  /**
   * One stable attachment for every card's scrolling body: the title comes from
   * the element, so the attachment is not re-created (and its observer not
   * rebuilt) on every render the way a factory returning a fresh function would
   * be.
   *
   * It measures the *body*, not the card. The card is the box being sized, so its
   * scroll height is the height it was given: measuring it would feed the layout
   * back into itself and freeze every section at whatever it happened to be on
   * the first pass. The body scrolls, so its `scrollHeight` is the content's real
   * height however little of it is on screen, and the chrome around it (header,
   * borders) is the difference between the two boxes.
   */
  const measureCard: Attachment<HTMLElement> = (element) => {
    const title = element.dataset.cardBody
    if (!title) return
    const measure = (): void => {
      const card = element.closest<HTMLElement>('[data-card-title]')
      const chrome = card ? card.offsetHeight - element.clientHeight : 0
      const natural = element.scrollHeight + Math.max(0, chrome)
      if (naturalHeights[title] === natural) return
      naturalHeights = { ...naturalHeights, [title]: natural }
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }

  /**
   * The height each card takes, from the water fill: a short section hugs its
   * content and hands the rest of the column to the sections that still want
   * more, and only a column that is full everywhere leaves a section scrolling
   * inside its own share.
   *
   * Null until the first measurement lands, so the first paint uses the equal
   * share below and never flashes a collapsed column.
   */
  const cardHeights = $derived.by(() => {
    if (columnHeight === 0) return null
    const measured = cards.map((card) => naturalHeights[card.title])
    if (measured.some((height) => height === undefined)) return null
    // `p-1` above and below, and the 4px gap between cards.
    const available = columnHeight - 8 - (cards.length - 1) * 4
    return waterFillHeights(available, measured)
  })

  /**
   * The fallback maximum one card may take: an equal share of the column.
   *
   * A maximum, not a height. A card with three files uses three rows and leaves
   * the rest at the bottom of the panel, which is why a short section never
   * forces the whole view to scroll while there is room to spare. Once every
   * card has more rows than its share, the shares are what is left and each
   * card scrolls on its own, so one long section cannot push the others out of
   * sight.
   */
  const cardShare = $derived.by(() => {
    const count = Math.max(cards.length, 1)
    // The column's `gap-1` between cards is taken out of the height first.
    return `max-height: calc((100% - ${(count - 1) * 4}px) / ${count})`
  })

  /**
   * Whether every file of the open commit is selected. The commit's own header
   * carries the select-all switch, so its state has to be known outside the
   * rows that own the individual selection.
   */
  const commitAllSelected = $derived(
    commitDiffChanges.length > 0 && commitDiffChanges.every((file) => selectedPaths[file.path])
  )
</script>

{#snippet commitTreeNode(node: CommitTreeNode, depth: number)}
  {#each sortCommitDirs(node.dirs) as dir (dir.path)}
    {@const dirCollapsed = commitTreeCollapsedDirs[dir.path] ?? false}
    <!--
      A directory of the open commit can be revealed in the files tree, the
      same as a directory of the working tree: seeing which files a commit
      touched is only half the question, the other half is looking at them.
    -->
    <ContextMenu.Root>
      <ContextMenu.Trigger
        class="block w-full"
        aria-label={`Actions for directory ${dir.path} in this commit`}
      >
        <button
          type="button"
          class="flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 text-left transition-colors hover:bg-elevated/50"
          style={`padding-left: ${8 + depth * 14}px`}
          title={dirCollapsed ? `Expand ${dir.path}` : `Collapse ${dir.path}`}
          onclick={() => toggleCommitDir(dir.path)}
        >
          {#if dirCollapsed}
            <CioForward size={12} class="shrink-0 text-dimmed" />
            <CioFolder size={13} class="shrink-0 text-dimmed" />
          {:else}
            <CioChevronDown size={12} class="shrink-0 text-dimmed" />
            <CioFolderOpen size={13} class="shrink-0 text-dimmed" />
          {/if}
          <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted"
            >{dir.name}</span
          >
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
          <ContextMenu.Item
            class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
            onSelect={() => openDirectory(dir.path)}
          >
            <CioFolderOpen size={12} class="text-warning" />
            Open directory
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {#if !dirCollapsed}
      {@render commitTreeNode(dir, depth + 1)}
    {/if}
  {/each}
  {#each node.files as change (change.path)}
    <div style={`padding-left: ${8 + depth * 14}px`}>
      <GitFileRow
        {change}
        displayPath={change.path.split('/').pop() ?? change.path}
        diff={commitDiffs[change.path] ?? null}
        loadingDiff={loadingCommitDiffFile[change.path] ?? false}
        error={commitDiffErrors[change.path] ?? null}
        expanded={commitExpanded[change.path] ?? false}
        selected={Boolean(selectedPaths[change.path])}
        selectable
        readonly
        openLabel="Open working copy"
        onToggleDiff={() => toggleCommitDiff(change)}
        onToggleStage={() => {}}
        onToggleSelect={(item, additive) => toggleSelection(item, additive)}
        onOpenInEditor={(path) => openInEditor(path)}
        onRemoveFromCommit={(path) => requestRemoveCommitChanges([path])}
      />
    </div>
  {/each}
{/snippet}

{#if selectedCommit}
  <!--
    The commit's identity and actions live in the panel's header and action
    row, so the diff starts at the top of the content region instead of
    under a second sticky copy of them.
  -->
  <div class="flex min-h-0 flex-1 flex-col p-2">
    {#if loadingCommitDiff}
      <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
        <CioSpinner size={14} class="animate-spin" />
        Loading diff
      </div>
    {:else if commitDiffChanges.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
        <CioCommit size={22} class="mx-auto mb-2 text-dimmed" />
        <p class="text-xs font-medium text-muted">No file changes</p>
        <p class="mt-1 text-[0.625rem] text-dimmed">This commit has no changes.</p>
      </div>
    {:else}
      <div
        class="flex min-h-0 flex-col overflow-hidden border border-border bg-surface"
        style="max-height: 100%"
      >
        <div class="flex shrink-0 items-center gap-1.5 bg-elevated/50 py-1 pl-1 pr-2">
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
              checked={commitAllSelected}
              onchange={() => toggleSectionSelection(commitDiffChanges)}
              title={commitAllSelected
                ? `Deselect all ${commitDiffChanges.length} files in this commit`
                : `Select all ${commitDiffChanges.length} files in this commit`}
              aria-label={commitAllSelected
                ? `Deselect all ${commitDiffChanges.length} files in this commit`
                : `Select all ${commitDiffChanges.length} files in this commit`}
              activeClass="border-primary bg-primary"
            />
          </span>
          <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
            Changed files
          </span>
          <span class="ml-auto text-[0.5rem] tabular-nums text-dimmed" title={summaryTitle}>
            {commitDiffChanges.length}
          </span>
        </div>
        <div class="min-h-0 overflow-y-auto">
          {#if changesView === 'tree'}
            {@render commitTreeNode(commitTree, 0)}
          {:else}
            {#each commitDiffChanges as change (change.path)}
              <GitFileRow
                {change}
                diff={commitDiffs[change.path] ?? null}
                loadingDiff={loadingCommitDiffFile[change.path] ?? false}
                error={commitDiffErrors[change.path] ?? null}
                expanded={commitExpanded[change.path] ?? false}
                selected={Boolean(selectedPaths[change.path])}
                selectable
                readonly
                openLabel="Open working copy"
                onToggleDiff={() => toggleCommitDiff(change)}
                onToggleStage={() => {}}
                onToggleSelect={(item, additive) => toggleSelection(item, additive)}
                onOpenInEditor={(path) => openInEditor(path)}
                onRemoveFromCommit={(path) => requestRemoveCommitChanges([path])}
                onRestore={(path, target) =>
                  restoreFromSource(selectedCommit?.hash ?? 'HEAD', path, target)}
              />
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  </div>
{:else}
  <div class="flex min-h-0 flex-1 flex-col">
    {#if status && changes.length === 0 && status.clean}
      <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
        <div class="mb-2 flex h-10 w-10 items-center justify-center bg-success/10">
          <CioCheck size={18} class="text-success" />
        </div>
        <p class="text-xs font-medium text-muted">Working tree is clean</p>
        <p class="mt-1 max-w-[26ch] text-[0.625rem] leading-relaxed text-dimmed">
          No staged, unstaged, or untracked changes.
        </p>
      </div>
    {:else if status}
      <!--
        One card per section, each capped at an equal share of the column (see
        `cardShare`). A card that holds fewer files than its share keeps only the
        height it needs, so the column does not scroll while room is left at the
        bottom; a card that holds more scrolls inside itself, so a long Unstaged
        section never hides Staged or Untracked above it.
      -->
      <div class="flex min-h-0 flex-1 flex-col gap-1 p-1" {@attach measureColumn}>
        {#each cards as card, cardIndex (card.title)}
          {@const measuredHeight = cardHeights?.[cardIndex]}
          <div
            class="flex min-h-0 flex-col"
            style={measuredHeight === undefined
              ? cardShare
              : `height: ${measuredHeight}px; flex: 0 0 auto`}
            data-card-title={card.title}
          >
            {#if changesView === 'tree'}
              <GitChangesTree
                sections={[card]}
                {diffs}
                {expanded}
                {loadingDiff}
                {diffErrors}
                {measureCard}
                bind:selectedPaths
                onToggleDiff={(change) => toggleDiff(change)}
                onToggleStage={(change) => toggleStage(change)}
                onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                onStagePaths={(paths, staged) => stagePathsAction(paths, staged)}
                onStashPaths={(paths) => requestStashFor(paths)}
                onOpenInEditor={(path) => openInEditor(path)}
                onOpenDirectory={(path) => openDirectory(path)}
                onIgnorePaths={(paths) => ignorePathsAction(paths)}
                onDiscardPaths={(paths) => requestDiscard(paths)}
                onResolveConflict={(path) => routeConflictResolution(path)}
                bind:expandedDirs
              />
            {:else}
              {@const sectionAllSelected =
                card.files.length > 0 && card.files.every((file) => selectedPaths[file.path])}
              <div
                class={[
                  'flex min-h-0 flex-1 flex-col overflow-hidden border bg-surface',
                  card.conflicts ? 'border-warning/25' : 'border-border'
                ]}
              >
                <div
                  class={[
                    'flex shrink-0 items-center gap-1.5 py-1 pl-1 pr-2',
                    card.conflicts ? 'bg-warning/10' : 'bg-elevated/50'
                  ]}
                >
                  {#if !card.conflicts}
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
                        onchange={() => toggleSectionSelection(card.files)}
                        title={sectionAllSelected
                          ? `Deselect all ${card.files.length} files in ${card.title}`
                          : `Select all ${card.files.length} files in ${card.title}`}
                        aria-label={sectionAllSelected
                          ? `Deselect all ${card.files.length} files in ${card.title}`
                          : `Select all ${card.files.length} files in ${card.title}`}
                        activeClass="border-primary bg-primary"
                      />
                    </span>
                  {/if}
                  <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
                    {card.title}
                  </span>
                  <span class="ml-auto text-[0.5rem] tabular-nums text-dimmed">
                    {card.files.length}
                  </span>
                </div>
                <div
                  class="min-h-0 overflow-y-auto"
                  data-card-body={card.title}
                  {@attach measureCard}
                >
                  {#each card.files as change (change.path)}
                    <GitFileRow
                      {change}
                      diff={diffs[fileDiffKey(change)] ?? null}
                      loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                      error={diffErrors[fileDiffKey(change)] ?? null}
                      expanded={expanded[fileDiffKey(change)] ?? false}
                      selected={Boolean(selectedPaths[change.path])}
                      selectable={!card.conflicts}
                      onToggleDiff={() => toggleDiff(change)}
                      onToggleStage={() => toggleStage(change)}
                      onToggleSelect={(item, additive) => toggleSelection(item, additive)}
                      onStash={(path) => requestStashFor([path])}
                      onOpenInEditor={(path) => openInEditor(path)}
                      onIgnore={(path) => ignorePathsAction([path])}
                      onDiscard={(path) => requestDiscard([path])}
                      onResolveConflict={card.conflicts
                        ? (path) => routeConflictResolution(path)
                        : undefined}
                    />
                  {/each}
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}
