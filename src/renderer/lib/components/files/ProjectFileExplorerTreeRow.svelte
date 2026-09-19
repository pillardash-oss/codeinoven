<script lang="ts">
  import { ChevronDown, ChevronRight, Loader2 } from '@lucide/svelte'
  import type { ProjectFileEntry } from '$shared/types'
  import type { ProjectFilesState } from '$lib/stores/project-files.svelte'
  import FileTypeIcon from './FileTypeIcon.svelte'
  import FolderTypeIcon from './FolderTypeIcon.svelte'
  import ProjectFileContextMenu from './ProjectFileContextMenu.svelte'
  import type {
    CreateTreeRow,
    EntryTreeRow,
    ErrorTreeRow,
    InlineEdit,
    TreeRow
  } from './project-file-explorer-tree'

  interface Props {
    row: TreeRow
    inlineEdit: InlineEdit | null
    operationPending: boolean
    projectState: ProjectFilesState
    dropFolder: string | null
    dropIndicator: { path: string; position: 'before' | 'after' } | null
    canPaste: boolean
    isRowActive: (path: string) => boolean
    onCommitInline: () => void
    onInlineKeydown: (event: KeyboardEvent) => void
    onRetryLoad: (path: string) => void
    onCreateFile: (directory: string) => void
    onCreateFolder: (entry: ProjectFileEntry) => void
    onCopy: (entry: ProjectFileEntry) => void
    onCopyPath: (entry: ProjectFileEntry) => void
    onCut: (entry: ProjectFileEntry) => void
    onPaste: (entry: ProjectFileEntry) => void
    onRename: (entry: ProjectFileEntry) => void
    onDelete: (entry: ProjectFileEntry) => void
    onInfo: (entry: ProjectFileEntry) => void
    onReveal: (entry: ProjectFileEntry) => void
    onOpenInBrowser: (entry: ProjectFileEntry) => void
    onRowClick: (entry: ProjectFileEntry, event: MouseEvent) => void
    onRowDoubleClick: (entry: ProjectFileEntry, event: MouseEvent) => void
    onRowContextMenu: (entry: ProjectFileEntry) => void
    onRowPointerDown: (entry: ProjectFileEntry) => void
    onRowDragStart: (entry: ProjectFileEntry, event: DragEvent) => void
  }

  let {
    row,
    inlineEdit,
    operationPending,
    projectState,
    dropFolder,
    dropIndicator,
    canPaste,
    isRowActive,
    onCommitInline,
    onInlineKeydown,
    onRetryLoad,
    onCreateFile,
    onCreateFolder,
    onCopy,
    onCopyPath,
    onCut,
    onPaste,
    onRename,
    onDelete,
    onInfo,
    onReveal,
    onOpenInBrowser,
    onRowClick,
    onRowDoubleClick,
    onRowContextMenu,
    onRowPointerDown,
    onRowDragStart
  }: Props = $props()
</script>

{#if row.kind === 'create'}
  {@const createRow = row as CreateTreeRow}
  {#if inlineEdit?.kind === 'create'}
    <div
      class="flex h-7 items-center gap-1.5 pr-2 text-[0.6875rem] text-foreground"
      style:padding-left={`${22 + createRow.depth * 14}px`}
    >
      <FileTypeIcon path={inlineEdit.value} />
      <input
        data-inline-input
        bind:value={inlineEdit.value}
        class="h-6 min-w-0 flex-1 rounded border border-primary bg-app px-1.5 text-[0.6875rem] text-foreground outline-none"
        aria-label="New file name"
        placeholder="filename.ext"
        disabled={operationPending}
        onkeydown={onInlineKeydown}
        onblur={onCommitInline}
      />
    </div>
  {/if}
  {#if inlineEdit?.kind === 'create-directory' && inlineEdit.directory === createRow.directory}
    <div
      class="flex h-7 items-center gap-1.5 pr-2 text-[0.6875rem] text-foreground"
      style:padding-left={`${22 + createRow.depth * 14}px`}
    >
      <FolderTypeIcon name={inlineEdit.value} size={13} />
      <input
        data-inline-input
        bind:value={inlineEdit.value}
        class="h-6 min-w-0 flex-1 rounded border border-primary bg-app px-1.5 text-[0.6875rem] text-foreground outline-none"
        aria-label="New folder name"
        placeholder="folder-name"
        disabled={operationPending}
        onkeydown={onInlineKeydown}
        onblur={onCommitInline}
      />
    </div>
  {/if}
{:else if row.kind === 'error'}
  {@const errorRow = row as ErrorTreeRow}
  <div
    class="flex h-7 items-center gap-2 pr-2 text-[0.625rem] text-danger"
    style:padding-left={`${22 + errorRow.depth * 14}px`}
  >
    <span class="min-w-0 flex-1 truncate">{errorRow.message}</span>
    <button
      type="button"
      class="shrink-0 font-medium text-foreground hover:underline"
      onclick={() => onRetryLoad(errorRow.entry.path)}
    >
      Retry
    </button>
  </div>
{:else}
  {@const entryRow = row as EntryTreeRow}
  {@const entry = entryRow.entry}
  <ProjectFileContextMenu
    {entry}
    selectedPaths={projectState.selectedPaths}
    {canPaste}
    onCreateFile={() => onCreateFile(entry.path)}
    onCreateFolder={() => onCreateFolder(entry)}
    onCopy={() => onCopy(entry)}
    onCopyPath={() => onCopyPath(entry)}
    onCut={() => onCut(entry)}
    onPaste={() => onPaste(entry)}
    onRename={() => onRename(entry)}
    onDelete={() => onDelete(entry)}
    onInfo={() => onInfo(entry)}
    onReveal={() => onReveal(entry)}
    onOpenInBrowser={() => onOpenInBrowser(entry)}
  >
    {#if inlineEdit?.kind === 'rename' && inlineEdit.entry.path === entry.path}
      <div
        class="flex h-7 items-center gap-1.5 pr-2 text-[0.6875rem] text-foreground"
        style:padding-left={`${22 + entryRow.depth * 14}px`}
      >
        {#if inlineEdit.entry.kind === 'directory'}
          <FolderTypeIcon name={inlineEdit.value} size={13} />
        {:else}
          <FileTypeIcon path={inlineEdit.value} />
        {/if}
        <input
          data-inline-input
          bind:value={inlineEdit.value}
          class="h-6 min-w-0 flex-1 rounded border border-primary bg-app px-1.5 text-[0.6875rem] text-foreground outline-none"
          aria-label={`Rename ${entry.name}`}
          disabled={operationPending}
          onkeydown={onInlineKeydown}
          onblur={onCommitInline}
        />
      </div>
    {:else}
      <button
        type="button"
        data-tree-path={entry.path}
        draggable="true"
        class={[
          'relative flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[0.6875rem] transition-colors hover:bg-elevated',
          isRowActive(entry.path) ? 'bg-overlay text-foreground' : 'text-muted',
          dropFolder === entry.path ? 'bg-primary/10' : ''
        ]}
        style:padding-left={`${8 + entryRow.depth * 14}px`}
        title={entry.path}
        onclick={(event: MouseEvent) => onRowClick(entry, event)}
        ondblclick={(event: MouseEvent) => onRowDoubleClick(entry, event)}
        oncontextmenu={() => onRowContextMenu(entry)}
        onpointerdown={() => onRowPointerDown(entry)}
        ondragstart={(event: DragEvent) => onRowDragStart(entry, event)}
      >
        <div
          class="pointer-events-none absolute left-0 right-0 top-0 h-[2px] transition-opacity duration-100 {dropIndicator?.path ===
            entry.path && dropIndicator.position === 'before'
            ? 'bg-primary opacity-100'
            : 'opacity-0'}"
        ></div>
        <div
          class="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] transition-opacity duration-100 {dropIndicator?.path ===
            entry.path && dropIndicator.position === 'after'
            ? 'bg-primary opacity-100'
            : 'opacity-0'}"
        ></div>
        {#if entry.kind === 'directory'}
          {#if projectState.loadingDirectories[entry.path]}
            <Loader2 size={12} class="shrink-0 animate-spin text-dimmed" />
          {:else if projectState.expandedDirectories[entry.path]}
            <ChevronDown size={12} class="shrink-0 text-dimmed" />
          {:else}
            <ChevronRight size={12} class="shrink-0 text-dimmed" />
          {/if}
          {#if projectState.expandedDirectories[entry.path]}
            <FolderTypeIcon name={entry.name} open size={13} />
          {:else}
            <FolderTypeIcon name={entry.name} size={13} />
          {/if}
        {:else}
          <span class="w-3 shrink-0"></span>
          <FileTypeIcon path={entry.path} />
        {/if}
        <span class="min-w-0 flex-1 truncate">{entry.name}</span>
        {#if entry.kind === 'file' && projectState.sessions[entry.path] && projectState.sessions[entry.path].draft !== projectState.sessions[entry.path].source.content}
          <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes"></span>
        {/if}
      </button>
    {/if}
  </ProjectFileContextMenu>
{/if}
