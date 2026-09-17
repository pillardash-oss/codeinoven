<script lang="ts">
  import { Check } from '@lucide/svelte'
  import { ChevronDown, ChevronRight, Folder, FolderOpen } from '@lucide/svelte'
  import { GitCommit, Loader2 } from '@lucide/svelte'
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
    paneClass: string
    toggleDiff: (change: GitFileChange) => void
    toggleStage: (change: GitFileChange) => void
    toggleSelection: (change: GitFileChange, additive: boolean) => void
    toggleSectionSelection: (sectionFiles: GitFileChange[]) => void
    stagePathsAction: (paths: string[], staged: boolean) => void
    requestStashFor: (paths: string[]) => void
    openInEditor: (path: string) => void
    ignorePathsAction: (paths: string[]) => void
    requestDiscard: (paths: string[]) => void
    routeConflictResolution: (initial?: string) => void
    restoreFromSource: (source: string, path: string, target: GitRestoreTarget) => void
    toggleCommitDiff: (change: GitFileChange) => void
    toggleCommitDir: (path: string) => void
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
    paneClass,
    toggleDiff,
    toggleStage,
    toggleSelection,
    toggleSectionSelection,
    stagePathsAction,
    requestStashFor,
    openInEditor,
    ignorePathsAction,
    requestDiscard,
    routeConflictResolution,
    restoreFromSource,
    toggleCommitDiff,
    toggleCommitDir
  }: Props = $props()
</script>

{#snippet commitTreeNode(node: CommitTreeNode, depth: number)}
  {#each sortCommitDirs(node.dirs) as dir (dir.path)}
    {@const dirCollapsed = commitTreeCollapsedDirs[dir.path] ?? false}
    <button
      type="button"
      class="flex h-7 w-full cursor-pointer items-center gap-1.5 pr-2 text-left transition-colors hover:bg-elevated/50"
      style={`padding-left: ${8 + depth * 14}px`}
      onclick={() => toggleCommitDir(dir.path)}
    >
      {#if dirCollapsed}
        <ChevronRight size={12} class="shrink-0 text-dimmed" />
        <Folder size={13} class="shrink-0 text-dimmed" />
      {:else}
        <ChevronDown size={12} class="shrink-0 text-dimmed" />
        <FolderOpen size={13} class="shrink-0 text-dimmed" />
      {/if}
      <span class="min-w-0 flex-1 truncate font-mono text-[0.625rem] text-muted">{dir.name}</span>
    </button>
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
        readonly
        onToggleDiff={() => toggleCommitDiff(change)}
        onToggleStage={() => {}}
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
  <div class="p-2">
    {#if loadingCommitDiff}
      <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
        <Loader2 size={14} class="animate-spin" />
        Loading diff
      </div>
    {:else if commitDiffChanges.length === 0}
      <div class="flex flex-col items-center justify-center py-12 text-center">
        <GitCommit size={22} class="mx-auto mb-2 text-dimmed" />
        <p class="text-xs font-medium text-muted">No file changes</p>
        <p class="mt-1 text-[0.625rem] text-dimmed">This commit has no changes.</p>
      </div>
    {:else}
      <div class="overflow-hidden rounded-lg border border-border bg-surface">
        <div class="flex items-center gap-1.5 bg-elevated/50 px-2.5 py-1">
          <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
            Changed files
          </span>
          <span class="text-[0.5rem] tabular-nums text-dimmed">
            {commitDiffChanges.length}
          </span>
        </div>
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
              readonly
              onToggleDiff={() => toggleCommitDiff(change)}
              onToggleStage={() => {}}
              onRestore={(path, target) =>
                restoreFromSource(selectedCommit?.hash ?? 'HEAD', path, target)}
            />
          {/each}
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <!--
    Grow to the full region only while an empty state has to centre
    itself. With changes present the column hugs its content, so the
    sticky toolbar stays pinned for the whole scroll instead of being
    cut off once its containing block leaves the scrollport.
  -->
  <div class={['flex flex-col', changes.length === 0 ? 'h-full min-h-0' : null]}>
    {#if status && changes.length === 0 && status.clean}
      <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
        <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
          <Check size={18} class="text-success" />
        </div>
        <p class="text-xs font-medium text-muted">Working tree is clean</p>
        <p class="mt-1 max-w-[26ch] text-[0.625rem] leading-relaxed text-dimmed">
          No staged, unstaged, or untracked changes.
        </p>
      </div>
    {:else if status}
      <!--
        Staged / working panes   conflicts sit on top; each pane shares the
        height. Each pane carries a little padding of its own (see
        `paneClass`) so the staged and unstaged cards read as separate
        containers, and the wrapper's inset is what lines their outer edge
        up with the rows above: its 4px here plus the pane's own 4px is the
        8px the first card keeps from the action row, the same as its sides.
        The top inset used to be left to the pane alone, which put the
        first card 4px under the header while the other three sides had 8.
      -->
      <div class="flex flex-col gap-1 p-1">
        {#if conflictSections.length > 0}
          <div class={paneClass}>
            {#if changesView === 'tree'}
              <GitChangesTree
                sections={conflictSections}
                {diffs}
                {expanded}
                {loadingDiff}
                {diffErrors}
                bind:selectedPaths
                onToggleDiff={(change) => toggleDiff(change)}
                onToggleStage={(change) => toggleStage(change)}
                onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                onStagePaths={(paths, staged) => stagePathsAction(paths, staged)}
                onStashPaths={(paths) => requestStashFor(paths)}
                onOpenInEditor={(path) => openInEditor(path)}
                onIgnorePaths={(paths) => ignorePathsAction(paths)}
                onDiscardPaths={(paths) => requestDiscard(paths)}
                onResolveConflict={(path) => routeConflictResolution(path)}
              />
            {:else}
              <div class="overflow-hidden rounded-lg border border-warning/25 bg-surface">
                {#each conflictSections as section, si (section.title)}
                  {#if si > 0}<div class="border-t border-border"></div>{/if}
                  <div class="flex items-center gap-1.5 bg-warning/10 px-2.5 py-1">
                    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
                      {section.title}
                    </span>
                    <span class="text-[0.5rem] tabular-nums text-dimmed">
                      {section.files.length}
                    </span>
                  </div>
                  {#each section.files as change (change.path)}
                    <GitFileRow
                      {change}
                      diff={diffs[fileDiffKey(change)] ?? null}
                      loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                      error={diffErrors[fileDiffKey(change)] ?? null}
                      expanded={expanded[fileDiffKey(change)] ?? false}
                      onToggleDiff={() => toggleDiff(change)}
                      onToggleStage={() => toggleStage(change)}
                      onOpenInEditor={(path) => openInEditor(path)}
                      onResolveConflict={(path) => routeConflictResolution(path)}
                    />
                  {/each}
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if stagedSections.length > 0}
          <div class={paneClass}>
            {#if changesView === 'tree'}
              <GitChangesTree
                sections={stagedSections}
                {diffs}
                {expanded}
                {loadingDiff}
                {diffErrors}
                bind:selectedPaths
                onToggleDiff={(change) => toggleDiff(change)}
                onToggleStage={(change) => toggleStage(change)}
                onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                onStagePaths={(paths, staged) => stagePathsAction(paths, staged)}
                onStashPaths={(paths) => requestStashFor(paths)}
                onOpenInEditor={(path) => openInEditor(path)}
                onIgnorePaths={(paths) => ignorePathsAction(paths)}
                onDiscardPaths={(paths) => requestDiscard(paths)}
              />
            {:else}
              <div class="overflow-hidden rounded-lg border border-border bg-surface">
                {#each stagedSections as section, si (section.title)}
                  {#if si > 0}<div class="border-t border-border"></div>{/if}
                  {@const sectionAllSelected =
                    section.files.length > 0 && section.files.every((f) => selectedPaths[f.path])}
                  <div class="flex items-center gap-1.5 bg-elevated/50 px-2.5 py-1">
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
                        onchange={() => toggleSectionSelection(section.files)}
                        title={sectionAllSelected
                          ? `Deselect all ${section.files.length} files in ${section.title}`
                          : `Select all ${section.files.length} files in ${section.title}`}
                        aria-label={sectionAllSelected
                          ? `Deselect all ${section.files.length} files in ${section.title}`
                          : `Select all ${section.files.length} files in ${section.title}`}
                        activeClass="border-primary bg-primary"
                      />
                    </span>
                    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
                      {section.title}
                    </span>
                    <span class="text-[0.5rem] tabular-nums text-dimmed">
                      {section.files.length}
                    </span>
                  </div>
                  {#each section.files as change (change.path)}
                    <GitFileRow
                      {change}
                      diff={diffs[fileDiffKey(change)] ?? null}
                      loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                      error={diffErrors[fileDiffKey(change)] ?? null}
                      expanded={expanded[fileDiffKey(change)] ?? false}
                      selected={Boolean(selectedPaths[change.path])}
                      selectable
                      onToggleDiff={() => toggleDiff(change)}
                      onToggleStage={() => toggleStage(change)}
                      onToggleSelect={(item, additive) => toggleSelection(item, additive)}
                      onStash={(path) => requestStashFor([path])}
                      onOpenInEditor={(path) => openInEditor(path)}
                      onIgnore={(path) => ignorePathsAction([path])}
                      onDiscard={(path) => requestDiscard([path])}
                    />
                  {/each}
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        {#if workingSections.length > 0}
          <div class={paneClass}>
            {#if changesView === 'tree'}
              <GitChangesTree
                sections={workingSections}
                {diffs}
                {expanded}
                {loadingDiff}
                {diffErrors}
                bind:selectedPaths
                onToggleDiff={(change) => toggleDiff(change)}
                onToggleStage={(change) => toggleStage(change)}
                onToggleSelect={(change, additive) => toggleSelection(change, additive)}
                onStagePaths={(paths, staged) => stagePathsAction(paths, staged)}
                onStashPaths={(paths) => requestStashFor(paths)}
                onOpenInEditor={(path) => openInEditor(path)}
                onIgnorePaths={(paths) => ignorePathsAction(paths)}
                onDiscardPaths={(paths) => requestDiscard(paths)}
              />
            {:else}
              <div class="overflow-hidden rounded-lg border border-border bg-surface">
                {#each workingSections as section, si (section.title)}
                  {#if si > 0}<div class="border-t border-border"></div>{/if}
                  {@const sectionAllSelected =
                    section.files.length > 0 && section.files.every((f) => selectedPaths[f.path])}
                  <div class="flex items-center gap-1.5 bg-elevated/50 px-2.5 py-1">
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
                        onchange={() => toggleSectionSelection(section.files)}
                        title={sectionAllSelected
                          ? `Deselect all ${section.files.length} files in ${section.title}`
                          : `Select all ${section.files.length} files in ${section.title}`}
                        aria-label={sectionAllSelected
                          ? `Deselect all ${section.files.length} files in ${section.title}`
                          : `Select all ${section.files.length} files in ${section.title}`}
                        activeClass="border-primary bg-primary"
                      />
                    </span>
                    <span class="text-[0.5625rem] font-semibold uppercase tracking-wide text-muted">
                      {section.title}
                    </span>
                    <span class="text-[0.5rem] tabular-nums text-dimmed">
                      {section.files.length}
                    </span>
                  </div>
                  {#each section.files as change (change.path)}
                    <GitFileRow
                      {change}
                      diff={diffs[fileDiffKey(change)] ?? null}
                      loadingDiff={loadingDiff[fileDiffKey(change)] ?? false}
                      error={diffErrors[fileDiffKey(change)] ?? null}
                      expanded={expanded[fileDiffKey(change)] ?? false}
                      selected={Boolean(selectedPaths[change.path])}
                      selectable
                      onToggleDiff={() => toggleDiff(change)}
                      onToggleStage={() => toggleStage(change)}
                      onToggleSelect={(item, additive) => toggleSelection(item, additive)}
                      onStash={(path) => requestStashFor([path])}
                      onOpenInEditor={(path) => openInEditor(path)}
                      onIgnore={(path) => ignorePathsAction([path])}
                      onDiscard={(path) => requestDiscard([path])}
                    />
                  {/each}
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
