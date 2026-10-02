<script lang="ts">
  import { tick } from 'svelte'
  import {
    Maximize2,
    NotebookPen,
    Pencil,
    Plus,
    Redo2,
    Undo2,
    X
  } from '@lucide/svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { stickyNotes, type StickyNoteEntry } from '$lib/stores/sticky-notes.svelte'
  import type { StickyNoteAppearance } from '$shared/types'

  let editor = $state<HTMLTextAreaElement | null>(null)
  let createError = $state<string | null>(null)
  let editingNoteId = $state<string | null>(null)
  let editDraft = $state<StickyNoteAppearance | null>(null)
  let deletingNoteId = $state<string | null>(null)
  let deleting = $state(false)
  let deleteError = $state<string | null>(null)
  let fullscreen = $state(false)

  const activeNote = $derived(stickyNotes.activeNote)
  const deletingNote = $derived(
    deletingNoteId ? stickyNotes.note(deletingNoteId) : null
  )

  void stickyNotes.load().catch(() => {})

  async function createNote(): Promise<void> {
    if (!stickyNotes.isLoaded) return
    createError = null
    try {
      await stickyNotes.create()
      await tick()
      editor?.focus()
    } catch (error) {
      createError = error instanceof Error ? error.message : 'Could not create a sticky note'
    }
  }

  function editNote(note: StickyNoteEntry): void {
    editingNoteId = note.id
    editDraft = {
      title: note.title,
      iconType: note.iconType,
      customSvg: note.customSvg,
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
      deletingNoteId = null
    } catch (error) {
      deleteError = error instanceof Error ? error.message : 'Could not delete this sticky note'
    } finally {
      deleting = false
    }
  }

  function handleEditorKeydown(event: KeyboardEvent, noteId: string): void {
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key === 'z') {
      event.preventDefault()
      if (event.shiftKey) stickyNotes.redo(noteId)
      else stickyNotes.undo(noteId)
    } else if (key === 'y') {
      event.preventDefault()
      stickyNotes.redo(noteId)
    }
  }

  function noteIcon(note: StickyNoteEntry): string | null {
    if (note.customSvg) return getCustomSvgDataUrl(note.customSvg, note.color)
    if (note.iconType) return getIconSvgDataUrl(note.iconType, note.color)
    return null
  }
</script>

{#snippet editorSurface(note: StickyNoteEntry, expanded: boolean)}
  <div class="flex h-full min-h-0 flex-col bg-app" style:--sticky-note-accent={note.color}>
    <div class="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface px-2.5">
      <div class="flex min-w-0 items-center gap-2">
        {#if stickyNotes.canUndo(note.id)}
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Undo"
            aria-label="Undo sticky note edit"
            onclick={() => stickyNotes.undo(note.id)}
          >
            <Undo2 size={14} />
          </button>
        {/if}
        {#if stickyNotes.canRedo(note.id)}
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Redo"
            aria-label="Redo sticky note edit"
            onclick={() => stickyNotes.redo(note.id)}
          >
            <Redo2 size={14} />
          </button>
        {/if}
        <span class="truncate text-xs text-muted" aria-live="polite">
          {#if note.saveState === 'saving'}
            Saving…
          {:else if note.saveState === 'pending'}
            Changes not saved yet
          {:else if note.saveState === 'error'}
            Save failed
          {:else}
            Saved
          {/if}
        </span>
        {#if note.saveError}
          <span class="sr-only" role="status">{note.saveError}</span>
        {/if}
      </div>
      {#if !expanded}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Edit sticky note title, icon and colour"
          aria-label="Edit sticky note title, icon and colour"
          onclick={() => editNote(note)}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="View sticky note fullscreen"
          aria-label="View sticky note fullscreen"
          onclick={() => (fullscreen = true)}
        >
          <Maximize2 size={13} />
        </button>
      {:else}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Close fullscreen sticky note"
          aria-label="Close fullscreen sticky note"
          onclick={() => (fullscreen = false)}
        >
          <X size={14} />
        </button>
      {/if}
    </div>

    <textarea
      bind:this={editor}
      class="min-h-0 flex-1 resize-none border-0 border-l-2 border-l-[var(--sticky-note-accent)] bg-app px-4 py-3 text-sm leading-6 text-foreground outline-none placeholder:text-dimmed focus:ring-0"
      aria-label={`Sticky note: ${note.title}`}
      placeholder="Write a note…"
      value={note.body}
      disabled={!note.loaded || note.loading}
      oninput={(event) => stickyNotes.setBody(note.id, event.currentTarget.value)}
      onkeydown={(event) => handleEditorKeydown(event, note.id)}
    ></textarea>
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
        disabled={!stickyNotes.isLoaded}
        onclick={() => void createNote()}
      >
        <Plus size={13} />
        New sticky note
      </button>
      {#if createError}<p class="text-xs text-danger" role="alert">{createError}</p>{/if}
    </div>
  {:else}
    <div class="flex h-10 shrink-0 items-stretch border-b border-border bg-surface">
          <div class="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="group" aria-label="Sticky note tabs">
        {#each stickyNotes.entries as note (note.id)}
          {@const icon = noteIcon(note)}
          <div class="flex min-w-0 max-w-52 shrink-0 items-center" style:--sticky-note-accent={note.color}>
            <button
              type="button"
              class={[
                'flex h-full min-w-0 items-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors hover:bg-elevated',
                stickyNotes.activeNoteId === note.id
                  ? 'border-b-[var(--sticky-note-accent)] text-foreground'
                  : 'border-transparent text-muted'
              ]}
              style:--sticky-note-accent={note.color}
              aria-pressed={stickyNotes.activeNoteId === note.id}
              title="Right-click to edit title, icon and colour"
              oncontextmenu={(event) => {
                event.preventDefault()
                editNote(note)
              }}
              onclick={() => stickyNotes.select(note.id)}
            >
              {#if icon}
                <img src={icon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
              {:else}
                <NotebookPen size={13} class="shrink-0 text-[var(--sticky-note-accent)]" />
              {/if}
              <span class="truncate">{note.title}</span>
            </button>
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
              title="Close tab and delete sticky note"
              aria-label={`Close tab and delete sticky note ${note.title}`}
              onclick={() => requestDelete(note.id)}
            >
              <X size={12} />
            </button>
          </div>
        {/each}
      </div>
      <button
        type="button"
        class="flex h-9 w-9 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="New sticky note"
        aria-label="Create a new sticky note"
        disabled={!stickyNotes.isLoaded}
        onclick={() => void createNote()}
      >
        <Plus size={14} />
      </button>
    </div>

    {#if activeNote}
      {#if activeNote.loading}
        <div class="flex min-h-0 flex-1 items-center justify-center text-sm text-muted">
          Loading note…
        </div>
      {:else if !activeNote.loaded}
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <p class="text-sm text-muted">{activeNote.saveError ?? 'Could not load this sticky note.'}</p>
          <button
            type="button"
            class="rounded-lg border border-border bg-elevated px-3 py-1.5 text-xs text-foreground hover:bg-overlay"
            title="Retry loading this note"
            onclick={() => stickyNotes.select(activeNote.id)}
          >
            Retry
          </button>
        </div>
      {:else}
        {#if fullscreen}
          <div class="min-h-0 flex-1 bg-app" aria-hidden="true"></div>
        {:else}
          {@render editorSurface(activeNote, false)}
        {/if}
      {/if}
    {/if}
  {/if}
</div>

{#if activeNote?.loaded && fullscreen}
  <Modal
    open={fullscreen}
    title={activeNote.title}
    placement="fullscreen"
    chrome={false}
    panelClass="bg-app"
    contentClass="flex min-h-0 flex-1 flex-col"
    closeOnBackdrop={false}
    onClose={() => (fullscreen = false)}
  >
    {@render editorSurface(activeNote, true)}
  </Modal>
{/if}

{#if editDraft && editingNoteId}
  {#await import('./StickyNoteEditModal.svelte') then { default: StickyNoteEditModal }}
    <StickyNoteEditModal
      open
      noteId={editingNoteId}
      title={editDraft.title}
      iconType={editDraft.iconType}
      customSvg={editDraft.customSvg}
      color={editDraft.color}
      onTitleChange={(title) => editDraft && (editDraft.title = title)}
      onIconTypeChange={(iconType) => editDraft && (editDraft.iconType = iconType)}
      onCustomSvgChange={(customSvg) => editDraft && (editDraft.customSvg = customSvg)}
      onColorChange={(color) => editDraft && (editDraft.color = color)}
      onClose={() => {
        editDraft = null
        editingNoteId = null
      }}
      onSave={(appearance) => stickyNotes.updateAppearance(editingNoteId ?? '', appearance)}
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
