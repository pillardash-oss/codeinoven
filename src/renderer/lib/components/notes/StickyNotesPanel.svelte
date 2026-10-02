<script lang="ts">
  import { tick } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { Eye, Maximize2, NotebookPen, Redo2, SquarePen, Undo2 } from '@lucide/svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import PanelTabStrip from '$lib/components/workspace/PanelTabStrip.svelte'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { stickyNotes, type StickyNoteEntry } from '$lib/stores/sticky-notes.svelte'
  import type { StickyNoteAppearance } from '$shared/types'

  let createError = $state<string | null>(null)
  let editingNoteId = $state<string | null>(null)
  let editDraft = $state<StickyNoteAppearance | null>(null)
  let deletingNoteId = $state<string | null>(null)
  let deleting = $state(false)
  let deleteError = $state<string | null>(null)
  let fullscreen = $state(false)
  const editingIds = new SvelteSet<string>()
  let historyController = $state<{ undo: () => void; redo: () => void } | null>(null)
  let canUndo = $state(false)
  let canRedo = $state(false)

  const activeNote = $derived(stickyNotes.activeNote)
  const deletingNote = $derived(deletingNoteId ? stickyNotes.note(deletingNoteId) : null)
  const tabs = $derived(stickyNotes.entries.map(({ id, title }) => ({ id, title })))
  const activeIsEditing = $derived(activeNote ? editingIds.has(activeNote.id) : false)

  void stickyNotes.load().catch(() => {})

  async function focusEditor(noteId: string): Promise<void> {
    await tick()
    document.getElementById(`sticky-note-editor-${noteId}`)?.focus()
  }

  async function createNote(): Promise<void> {
    if (!stickyNotes.isLoaded) return
    createError = null
    try {
      const note = await stickyNotes.create()
      editingIds.add(note.id)
      await focusEditor(note.id)
    } catch (error) {
      createError = error instanceof Error ? error.message : 'Could not create a sticky note'
    }
  }

  function startEditing(noteId: string): void {
    editingIds.add(noteId)
    void focusEditor(noteId)
  }

  function stopEditing(noteId: string): void {
    editingIds.delete(noteId)
  }

  function editNote(note: StickyNoteEntry): void {
    editingNoteId = note.id
    editDraft = {
      title: note.title,
      iconType: note.iconType,
      customSvg: note.customSvg,
      imagePath: note.imagePath,
      color: note.color
    }
  }

  function requestDelete(noteId: string): void {
    deletingNoteId = noteId
    deleteError = null
  }

  async function confirmDelete(): Promise<void> {
    const noteId = deletingNoteId
    if (!noteId || deleting) return
    deleting = true
    deleteError = null
    try {
      await stickyNotes.delete(noteId)
      stopEditing(noteId)
      deletingNoteId = null
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete this sticky note'
    } finally {
      deleting = false
    }
  }

  function noteIcon(note: StickyNoteEntry): string | null {
    if (note.imageUrl) return note.imageUrl
    if (note.customSvg) return getCustomSvgDataUrl(note.customSvg, note.color)
    if (note.iconType) return getIconSvgDataUrl(note.iconType, note.color)
    return null
  }
</script>

{#snippet noteActions()}
  {#if activeNote?.loaded}
    {#if activeIsEditing}
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="View sticky note"
        aria-label="View sticky note"
        aria-pressed={!activeIsEditing}
        onclick={() => stopEditing(activeNote.id)}
      >
        <Eye size={14} />
      </button>
    {:else}
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Edit sticky note"
        aria-label="Edit sticky note"
        aria-pressed={activeIsEditing}
        onclick={() => startEditing(activeNote.id)}
      >
        <SquarePen size={14} />
      </button>
    {/if}
    {#if activeIsEditing && canUndo}
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Undo"
        aria-label="Undo sticky note edit"
        onclick={() => historyController?.undo()}
      >
        <Undo2 size={14} />
      </button>
    {/if}
    {#if activeIsEditing && canRedo}
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Redo"
        aria-label="Redo sticky note edit"
        onclick={() => historyController?.redo()}
      >
        <Redo2 size={14} />
      </button>
    {/if}
  {/if}
{/snippet}

{#snippet noteBody(note: StickyNoteEntry)}
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app">
    {#if note.loading}
      <p class="py-10 text-center text-sm text-dimmed">Loading note…</p>
    {:else if !note.loaded}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p class="text-sm text-muted">{note.saveError ?? 'Could not load this sticky note.'}</p>
        <button
          type="button"
          class="rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs text-foreground hover:bg-overlay"
          title="Retry loading this note"
          aria-label="Retry loading this note"
          onclick={() => stickyNotes.select(note.id)}
        >
          Retry
        </button>
      </div>
    {:else}
      {#key note.id}
        <RichMarkdownEditor
          id={`sticky-note-editor-${note.id}`}
          value={note.body}
          onValueChange={(body) => stickyNotes.setBody(note.id, body)}
          placeholder="Write a note…"
          ariaLabel={`Sticky note: ${note.title}`}
          containerClass={activeIsEditing ? 'min-h-0 flex-1' : 'hidden'}
          class="min-h-full w-full px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
          onHistoryControllerChange={(controller) => {
            if (stickyNotes.activeNoteId === note.id) historyController = controller
          }}
          onHistoryStateChange={(state) => {
            if (stickyNotes.activeNoteId === note.id) {
              canUndo = state.canUndo
              canRedo = state.canRedo
            }
          }}
        />
      {/key}
      {#if activeIsEditing}
        {#if note.saveError}
          <p class="px-3.5 pb-3 text-sm text-danger" role="alert">{note.saveError}</p>
        {/if}
      {:else if note.body.trim()}
        <MarkdownView text={note.body} class="w-full px-3.5 py-3 text-sm leading-5" />
      {:else}
        <p class="px-3.5 py-3 text-sm leading-5 text-dimmed">Nothing written yet.</p>
      {/if}
    {/if}
  </div>
{/snippet}

<div class="flex h-full min-h-0 flex-col bg-surface">
  {#if stickyNotes.isLoading && !stickyNotes.isLoaded}
    <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted">
      Loading sticky notes…
    </div>
  {:else if stickyNotes.error && !stickyNotes.isLoaded}
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <NotebookPen size={22} class="text-dimmed" />
      <p class="max-w-64 text-sm text-muted">{stickyNotes.error}</p>
      <button
        type="button"
        class="rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-foreground hover:bg-overlay"
        title="Retry loading sticky notes"
        aria-label="Retry loading sticky notes"
        onclick={() => void stickyNotes.load().catch(() => {})}
      >
        Retry
      </button>
    </div>
  {:else if stickyNotes.entries.length === 0}
    <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <NotebookPen size={22} class="text-dimmed" />
      <div class="space-y-1">
        <h2 class="text-sm font-medium text-foreground">No sticky notes yet</h2>
        <p class="text-xs text-muted">Create a note to keep it handy across the app.</p>
      </div>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-overlay disabled:opacity-50"
        title="Create a sticky note"
        aria-label="Create a sticky note"
        disabled={!stickyNotes.isLoaded}
        onclick={() => void createNote()}
      >
        <NotebookPen size={13} />
        New sticky note
      </button>
      {#if createError}<p class="text-xs text-danger" role="alert">{createError}</p>{/if}
    </div>
  {:else}
    <PanelTabStrip
      {tabs}
      activeTabId={stickyNotes.activeNoteId}
      trailingLabel="View sticky note fullscreen"
      onTrailingAction={() => (fullscreen = true)}
      onSelect={stickyNotes.select.bind(stickyNotes)}
      newLabel="New sticky note"
      onNew={() => void createNote()}
      onCloseTab={requestDelete}
      onTabContextMenu={(id) => {
        const note = stickyNotes.note(id)
        if (note) editNote(note)
      }}
    >
      {#snippet actions()}{@render noteActions()}{/snippet}
      {#snippet trailingIcon()}<Maximize2 size={14} />{/snippet}
      {#snippet tabIcon(tab)}
        {@const note = stickyNotes.note(tab.id)}
        {@const icon = note ? noteIcon(note) : null}
        {#if icon}
          <img src={icon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
        {:else}
          <NotebookPen size={13} class="shrink-0" />
        {/if}
      {/snippet}
    </PanelTabStrip>

    {#if activeNote}
      {@render noteBody(activeNote)}
    {/if}
    {#if createError}<p class="px-3.5 pb-2 text-xs text-danger" role="alert">{createError}</p>{/if}
  {/if}
</div>

{#if activeNote?.loaded && fullscreen}
    <FullscreenPanelDialog
    {tabs}
    activeTabId={stickyNotes.activeNoteId}
    newLabel="New sticky note"
    minimizeLabel="Exit fullscreen"
    onNew={() => void createNote()}
    onMinimize={() => (fullscreen = false)}
    onSelect={stickyNotes.select.bind(stickyNotes)}
    onCloseTab={requestDelete}
  >
    {#snippet actions()}{@render noteActions()}{/snippet}
    {#snippet tabIcon(tab)}
      {@const note = stickyNotes.note(tab.id)}
      {@const icon = note ? noteIcon(note) : null}
      {#if icon}
        <img src={icon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
      {:else}
        <NotebookPen size={13} class="shrink-0" />
      {/if}
    {/snippet}
    {#if activeNote}{@render noteBody(activeNote)}{/if}
  </FullscreenPanelDialog>
{/if}

{#if editDraft && editingNoteId}
  {#await import('./StickyNoteEditModal.svelte') then { default: StickyNoteEditModal }}
    <StickyNoteEditModal
      open
      noteId={editingNoteId}
      title={editDraft.title}
      iconType={editDraft.iconType}
      customSvg={editDraft.customSvg}
      imagePath={editDraft.imagePath}
      imageUrl={stickyNotes.note(editingNoteId)?.imageUrl ?? null}
      color={editDraft.color}
      onTitleChange={(title) => editDraft && (editDraft.title = title)}
      onIconTypeChange={(iconType) => editDraft && (editDraft.iconType = iconType)}
      onCustomSvgChange={(customSvg) => editDraft && (editDraft.customSvg = customSvg)}
      onColorChange={(color) => editDraft && (editDraft.color = color)}
      onClose={() => {
        editDraft = null
        editingNoteId = null
      }}
      onSave={(appearance, imageUrl) =>
        stickyNotes.updateAppearance(editingNoteId ?? '', appearance, imageUrl)}
    />
  {/await}
{/if}

<ConfirmDialog
  open={deletingNoteId !== null}
  title="Delete sticky note?"
  confirmLabel="Delete note"
  cancelLabel="Keep note"
  busy={deleting}
  onCancel={() => (deletingNoteId = null)}
  onConfirm={confirmDelete}
>
  <p>
    Closing this tab permanently deletes "{deletingNote?.title ?? 'this note'}" and its contents.
  </p>
  <p>You cannot recover a deleted sticky note.</p>
  {#if deleteError}<p class="text-danger" role="alert">{deleteError}</p>{/if}
</ConfirmDialog>
