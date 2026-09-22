<script lang="ts">
  import { Code2, Eye, FileDiff, Loader2, Save } from '@lucide/svelte'
  import type { ProjectFileTab, ProjectFileView } from '$lib/stores/project-files.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import ProjectFileViewerMenu from './ProjectFileViewerMenu.svelte'

  interface DiffStats {
    additions: number
    deletions: number
  }

  interface Props {
    activeTab: ProjectFileTab
    checkpointDiff: ProjectFileTab['checkpointDiff']
    diffStats: DiffStats | null
    previewKindLabel: string
    showPreviewToggle: boolean
    deletedAtCheckpoint: boolean
    showUndoRedo: boolean
    reloadDisabled: boolean
    mutationDisabled: boolean
    showLineNumbers: boolean
    wrapLines: boolean
    /** Format label the active file can be beautified as, or null when the
     *  editor cannot reformat it. */
    beautifyLabel: string | null
    showSaveButton: boolean
    saveDisabled: boolean
    saving: boolean
    saveLabel: string
    fullscreen: boolean
    onSetView: (view: ProjectFileView) => void
    onInfo: () => void
    /** File info is disabled for files that no longer exist on disk. */
    infoDisabled?: boolean
    onUndo: () => void
    onRedo: () => void
    onReload: () => void
    onToggleLineNumbers: () => void
    onToggleWrap: () => void
    onBeautify: () => void
    onFullscreen: () => void
    onRename: () => void
    onDelete: () => void
    onSave: () => void
  }

  let {
    activeTab,
    checkpointDiff,
    diffStats,
    previewKindLabel,
    showPreviewToggle,
    deletedAtCheckpoint,
    showUndoRedo,
    reloadDisabled,
    mutationDisabled,
    showLineNumbers,
    wrapLines,
    beautifyLabel,
    showSaveButton,
    saveDisabled,
    saving,
    saveLabel,
    fullscreen,
    onSetView,
    onInfo,
    infoDisabled = false,
    onUndo,
    onRedo,
    onReload,
    onToggleLineNumbers,
    onToggleWrap,
    onBeautify,
    onFullscreen,
    onRename,
    onDelete,
    onSave
  }: Props = $props()
</script>

<div class="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
  <button
    type="button"
    class={[
      'flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-30',
      activeTab.view === 'diff'
        ? 'bg-overlay text-foreground'
        : 'text-dimmed hover:bg-elevated hover:text-foreground'
    ]}
    aria-label="Show file diff"
    aria-pressed={activeTab.view === 'diff'}
    title="Diff"
    disabled={!checkpointDiff}
    onclick={() => onSetView('diff')}
  >
    <FileDiff size={12} />
  </button>
  {#if showPreviewToggle}
    <button
      type="button"
      class={[
        'flex h-6 w-6 items-center justify-center rounded transition-colors',
        activeTab.view === 'preview'
          ? 'bg-overlay text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={`Preview ${previewKindLabel}`}
      aria-pressed={activeTab.view === 'preview'}
      title={`${previewKindLabel} preview`}
      onclick={() => onSetView('preview')}
    >
      <Eye size={12} />
    </button>
  {/if}
  <button
    type="button"
    class={[
      'flex h-6 w-6 items-center justify-center rounded transition-colors',
      activeTab.view === 'source'
        ? 'bg-overlay text-foreground'
        : 'text-dimmed hover:bg-elevated hover:text-foreground'
    ]}
    aria-label="Edit source"
    aria-pressed={activeTab.view === 'source'}
    title={deletedAtCheckpoint ? 'View deleted source' : 'Edit source'}
    onclick={() => onSetView('source')}
  >
    <Code2 size={12} />
  </button>
  {#if deletedAtCheckpoint}
    <span class="ml-1 text-[0.5625rem] font-medium text-danger">Deleted · read-only</span>
  {/if}
  {#if diffStats}
    <span class="ml-1 font-mono text-[0.625rem] tabular-nums text-success" aria-label="Added lines"
      >+{diffStats.additions}</span
    >
    <span class="font-mono text-[0.625rem] tabular-nums text-danger" aria-label="Deleted lines"
      >−{diffStats.deletions}</span
    >
    {#if checkpointDiff?.truncated}
      <span class="text-[0.5625rem] text-warning" title="Preview truncated at 64 KiB"
        >Truncated</span
      >
    {/if}
    <DiffLayoutToggle title={diffLayoutToggleLabel(diffLayoutState.layout)} size={12} />
  {/if}
  <span class="flex-1"></span>
  <ProjectFileViewerMenu
    diffView={activeTab.view === 'diff'}
    lineNumbers={showLineNumbers}
    wrap={wrapLines}
    {reloadDisabled}
    {mutationDisabled}
    {showUndoRedo}
    {beautifyLabel}
    {fullscreen}
    {onInfo}
    {infoDisabled}
    {onUndo}
    {onRedo}
    {onReload}
    {onToggleLineNumbers}
    {onToggleWrap}
    {onBeautify}
    {onFullscreen}
    {onRename}
    {onDelete}
  />
  {#if showSaveButton}
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
      disabled={saveDisabled}
      aria-label={saveLabel}
      title={saveLabel}
      onclick={onSave}
    >
      {#if saving}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <Save size={11} />
      {/if}
    </button>
  {/if}
</div>
