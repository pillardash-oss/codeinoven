<script lang="ts">
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioDiff from '@pdslng/cio-icon/CioDiff.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioMessagePlus from '@pdslng/cio-icon/CioMessagePlus.svelte'
  import CioSave from '@pdslng/cio-icon/CioSave.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import type { ProjectFileTab, ProjectFileView } from '$lib/stores/project-files.svelte'
  import { diffLayoutState, diffLayoutToggleLabel } from '$lib/stores/diff-layout.svelte'
  import DiffLayoutToggle from '../ui/DiffLayoutToggle.svelte'
  import SpeechPlaybackButton from '../speech/SpeechPlaybackButton.svelte'
  import ProjectFileViewerMenu from './ProjectFileViewerMenu.svelte'
  import type { DocumentReadAloud } from './project-files-panel-read-aloud'

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
    /** Annotate is offered for the documents whose rendered preview can carry
     *  annotations (Markdown); nothing else has selectable text to anchor. */
    showAnnotateToggle: boolean
    /** Annotate is refused while no conversation is open to attach to. */
    annotateDisabled: boolean
    /** The active document as a read-aloud target, or null when the viewer
     *  cannot hand this file to the speech model. Same documents as the
     *  annotation toggle, and the control itself stays hidden until a
     *  text-to-speech model is installed. */
    readAloud: DocumentReadAloud | null
    deletedAtCheckpoint: boolean
    showUndoRedo: boolean
    /** Whether the source editor behind this toolbar can still undo / redo, so
     *  an action that would do nothing reads as unavailable. */
    canUndo: boolean
    canRedo: boolean
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
    /** Sentence behind the save button, for its `title`. Defaults to `saveLabel`. */
    saveTitle?: string
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
    showAnnotateToggle,
    annotateDisabled,
    readAloud,
    deletedAtCheckpoint,
    showUndoRedo,
    canUndo,
    canRedo,
    reloadDisabled,
    mutationDisabled,
    showLineNumbers,
    wrapLines,
    beautifyLabel,
    showSaveButton,
    saveDisabled,
    saving,
    saveLabel,
    saveTitle = undefined,
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
  <!-- Read-aloud leads the row, away from the view toggles: it is an action,
       and sitting between annotate and preview it was tapped by mistake. -->
  {#if readAloud}
    <SpeechPlaybackButton
      messageId={readAloud.messageId}
      markdown={readAloud.markdown}
      disabled={readAloud.disabled}
      scope={readAloud.scope}
      spokenSubject="document"
    />
  {/if}
  <button
    type="button"
    class={[
      'flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30',
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
    <CioDiff size={12} />
  </button>
  {#if showAnnotateToggle}
    <button
      type="button"
      class={[
        'flex h-6 w-6 items-center justify-center transition-colors disabled:opacity-30',
        activeTab.view === 'annotate'
          ? 'bg-overlay text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={`Annotate ${activeTab.path}`}
      aria-pressed={activeTab.view === 'annotate'}
      title={annotateDisabled
        ? 'Open a conversation to annotate this document'
        : 'Annotate this document and attach the notes to your next message'}
      disabled={annotateDisabled}
      onclick={() => onSetView('annotate')}
    >
      <CioMessagePlus size={12} />
    </button>
  {/if}
  {#if showPreviewToggle}
    <button
      type="button"
      class={[
        'flex h-6 w-6 items-center justify-center transition-colors',
        activeTab.view === 'preview'
          ? 'bg-overlay text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={`Preview ${previewKindLabel}`}
      aria-pressed={activeTab.view === 'preview'}
      title={`${previewKindLabel} preview`}
      onclick={() => onSetView('preview')}
    >
      <CioEye size={12} />
    </button>
  {/if}
  <button
    type="button"
    class={[
      'flex h-6 w-6 items-center justify-center transition-colors',
      activeTab.view === 'source'
        ? 'bg-overlay text-foreground'
        : 'text-dimmed hover:bg-elevated hover:text-foreground'
    ]}
    aria-label="Edit source"
    aria-pressed={activeTab.view === 'source'}
    title={deletedAtCheckpoint ? 'View deleted source' : 'Edit source'}
    onclick={() => onSetView('source')}
  >
    <CioCode size={12} />
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
    {canUndo}
    {canRedo}
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
      class="flex h-6 w-6 shrink-0 items-center justify-center bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
      disabled={saveDisabled}
      aria-label={saveLabel}
      title={saveTitle ?? saveLabel}
      onclick={onSave}
    >
      {#if saving}
        <CioSpinner size={11} class="animate-spin" />
      {:else}
        <CioSave size={11} />
      {/if}
    </button>
  {/if}
</div>
