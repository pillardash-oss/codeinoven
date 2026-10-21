<script lang="ts">
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioFind from '@pdslng/cio-icon/CioFind.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioNotes from '@pdslng/cio-icon/CioNotes.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioRedo from '@pdslng/cio-icon/CioRedo.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '$lib/components/speech/VoiceInputButton.svelte'
  import FindInSurface from '$lib/components/threads/FindInSurface.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import PanelTabStrip from '$lib/components/workspace/PanelTabStrip.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { motionDuration, slideWidth } from '$lib/motion'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { findNavState } from '$lib/stores/find-nav.svelte'
  import { stickyNotes, type StickyNoteEntry } from '$lib/stores/sticky-notes.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { StickyNoteAppearance } from '$shared/types'

  import { tick } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { DropdownMenu } from 'bits-ui'
  import { getCustomSvgDataUrl } from '../../../../lib/custom-svg-tint'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type { SpeechEditorTarget } from '../../speech/editor-target'

  let createError = $state<string | null>(null)
  let editingNoteId = $state<string | null>(null)
  let editDraft = $state<StickyNoteAppearance | null>(null)
  let deletingNoteId = $state<string | null>(null)
  let deleting = $state(false)
  let deleteError = $state<string | null>(null)
  let fullscreen = $state(false)
  let activeNoteMode = $state<{ noteId: string | null; mode: 'edit' | 'read' }>({
    noteId: null,
    mode: 'edit'
  })
  let historyController = $state<{ undo: () => void; redo: () => void } | null>(null)
  let richEditor = $state<RichMarkdownEditor>()
  let noteBodyEl = $state<HTMLDivElement | null>(null)
  let canUndo = $state(false)
  let canRedo = $state(false)

  const activeNote = $derived(stickyNotes.activeNote)
  const deletingNote = $derived(deletingNoteId ? stickyNotes.note(deletingNoteId) : null)
  const tabs = $derived(stickyNotes.entries.map(({ id, title }) => ({ id, title })))
  const activeIsEditing = $derived(
    activeNote !== null &&
      (activeNoteMode.noteId !== activeNote.id || activeNoteMode.mode === 'edit')
  )
  const speechTargetId = $derived(`sticky-note-${activeNote?.id ?? 'none'}`)
  const speechDisabled = $derived(!activeNote?.loaded || !activeIsEditing)
  const speechScope = $derived.by((): SpeechScope => {
    const thread = workspaceState.selectedThread
    return thread
      ? { kind: 'project', projectId: thread.projectId, threadId: thread.id }
      : { kind: 'global' }
  })

  function getSpeechTarget(): SpeechEditorTarget | null {
    return richEditor?.speechEditorTarget(speechTargetId) ?? null
  }

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
      activeNoteMode = { noteId: note.id, mode: 'edit' }
      await focusEditor(note.id)
    } catch (error) {
      createError = error instanceof Error ? error.message : 'Could not create a sticky note'
    }
  }

  function startEditing(noteId: string): void {
    stickyNotes.select(noteId)
    activeNoteMode = { noteId, mode: 'edit' }
    void focusEditor(noteId)
  }

  function stopEditing(noteId: string): void {
    if (stickyNotes.activeNoteId === noteId) activeNoteMode = { noteId, mode: 'read' }
  }

  /** The inline rail and the full screen surface each render their own note
   *  body, so switching layout destroys the DOM a find query was measured
   *  against. Leaving the bar open would reopen it over a body it never
   *  scanned, so the query goes with the surface it belonged to. */
  function toggleFullscreen(next: boolean): void {
    fullscreen = next
    findNavState.closeStickyNotesFind()
  }

  function selectNote(noteId: string): void {
    stickyNotes.select(noteId)
    activeNoteMode = { noteId, mode: 'edit' }
    canUndo = false
    canRedo = false
    historyController = null
    void focusEditor(noteId)
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

  /** One shape for every item in the strip's menu, so the reading, finding and
   *  full screen entries line up with the file viewer's overflow menu. */
  const menuItemClass =
    'flex items-center gap-2 px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'
</script>

{#snippet stripMenuItems()}
  <DropdownMenu.Item
    class={menuItemClass}
    disabled={!activeNote?.loaded}
    onSelect={() => {
      if (!activeNote) return
      if (activeIsEditing) stopEditing(activeNote.id)
      else startEditing(activeNote.id)
    }}
  >
    {#if activeIsEditing}
      <CioEye size={13} class="text-muted" />
      View note
    {:else}
      <CioPencil size={13} class="text-muted" />
      Edit note
    {/if}
  </DropdownMenu.Item>
  <DropdownMenu.Item
    class={menuItemClass}
    disabled={!activeNote?.loaded}
    title={`Find in this note (${keymapState.labelFor('nav-find')})`}
    onSelect={() => findNavState.openStickyNotesFind()}
  >
    <CioFind size={13} class="text-muted" />
    <span class="flex-1">Find in this note</span>
    <span class="text-[0.625rem] text-dimmed">{keymapState.labelFor('nav-find')}</span>
  </DropdownMenu.Item>
  {#if !fullscreen}
    <DropdownMenu.Separator class="my-1 h-px bg-border" />
    <DropdownMenu.Item class={menuItemClass} onSelect={() => toggleFullscreen(true)}>
      <CioMaximize size={13} class="text-muted" />
      Fullscreen
    </DropdownMenu.Item>
  {/if}
{/snippet}

<!--
  Reading, finding and filling the window are all things a reader reaches for
  occasionally, so they live behind one ellipsis instead of holding three slots
  in the strip. Editing stays the default state of the note, so the menu offers
  it as a whole item rather than a pressed toggle.
-->
{#snippet stripMenu()}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors data-[state=open]:bg-elevated data-[state=open]:text-foreground hover:bg-elevated hover:text-foreground"
      aria-label="Sticky note actions"
      title="Sticky note actions"
    >
      <CioEllipsis size={14} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={5}
        avoidCollisions
        collisionPadding={10}
        class="z-90 min-w-52 border border-border bg-surface p-1 shadow-lg"
      >
        {@render stripMenuItems()}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/snippet}

{#snippet tabIcon(tab: { id: string; title: string })}
  {@const note = stickyNotes.note(tab.id)}
  {@const icon = note ? noteIcon(note) : null}
  {#if icon}
    <img src={icon} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
  {:else}
    <CioNotes size={13} class="shrink-0" />
  {/if}
{/snippet}

{#snippet stripActions()}
  {#if activeNote?.loaded && activeIsEditing && canUndo}
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Undo"
      aria-label="Undo sticky note edit"
      onclick={() => historyController?.undo()}
      in:slideWidth={{ duration: motionDuration(160), easing: cubicOut }}
      out:slideWidth={{ duration: motionDuration(120), easing: cubicOut }}
      style="width: 1.75rem"
    >
      <CioUndo size={14} />
    </button>
  {/if}
  {#if activeNote?.loaded && activeIsEditing && canRedo}
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Redo"
      aria-label="Redo sticky note edit"
      onclick={() => historyController?.redo()}
      in:slideWidth={{ duration: motionDuration(160), easing: cubicOut }}
      out:slideWidth={{ duration: motionDuration(120), easing: cubicOut }}
      style="width: 1.75rem"
    >
      <CioRedo size={14} />
    </button>
  {/if}
  <VoiceInputButton
    targetId={speechTargetId}
    getTarget={getSpeechTarget}
    scope={speechScope}
    disabled={speechDisabled}
    class="h-7 w-7 text-dimmed"
  />
{/snippet}

{#snippet noteBody(note: StickyNoteEntry)}
  <!-- `relative` is what the find bar anchors to, and it sits outside the
       scrolling body so the bar stays put while the note scrolls. The bound
       container is the scroll body itself: it holds the editor and the reading
       view alike, and it survives the `{#key note.id}` that recreates the
       editor, so a note switch never leaves the finder pointing at dead DOM. -->
  <div data-region="sticky-notes" class="relative flex min-h-0 flex-1 flex-col">
    <div bind:this={noteBodyEl} class="flex min-h-0 flex-1 flex-col overflow-y-auto bg-app">
      {#if note.loading}
        <p class="py-10 text-center text-sm text-dimmed">Loading note…</p>
      {:else if !note.loaded}
        <div
          class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
        >
          <p class="text-sm text-muted">{note.saveError ?? 'Could not load this sticky note.'}</p>
          <button
            type="button"
            class="border border-border bg-elevated px-3 py-1.5 text-xs text-foreground hover:bg-overlay"
            title="Retry loading this note"
            aria-label="Retry loading this note"
            onclick={() => selectNote(note.id)}
          >
            Retry
          </button>
        </div>
      {:else}
        {#key note.id}
          <RichMarkdownEditor
            bind:this={richEditor}
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
    {#if findNavState.stickyNotesFindOpen && activeNote?.loaded}
      <FindInSurface
        container={noteBodyEl}
        focusTrigger={findNavState.stickyNotesFindFocusTrigger}
        label="Find in this note"
        placeholder="Find in this note…"
        onClose={() => findNavState.closeStickyNotesFind()}
      />
    {/if}
  </div>
{/snippet}

<!--
  The inline rail and the full screen surface are mutually exclusive, exactly as
  the assistant panel is: the note body renders once, in one of the two. Painting
  the body in both at once mounted two `RichMarkdownEditor`s that shared one
  element id, so `focusEditor` reached the hidden inline copy and typing in full
  screen went nowhere.
-->
{#if !fullscreen}
  <div class="flex h-full min-h-0 flex-col bg-surface">
    {#if stickyNotes.isLoading && !stickyNotes.isLoaded}
      <div class="flex min-h-0 flex-1 items-center justify-center px-6 text-sm text-muted">
        Loading sticky notes…
      </div>
    {:else if stickyNotes.error && !stickyNotes.isLoaded}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <CioNotes size={22} class="text-dimmed" />
        <p class="max-w-64 text-sm text-muted">{stickyNotes.error}</p>
        <button
          type="button"
          class="border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-foreground hover:bg-overlay"
          title="Retry loading sticky notes"
          aria-label="Retry loading sticky notes"
          onclick={() => void stickyNotes.load().catch(() => {})}
        >
          Retry
        </button>
      </div>
    {:else if stickyNotes.entries.length === 0}
      <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <CioNotes size={22} class="text-dimmed" />
        <div class="space-y-1">
          <h2 class="text-sm font-medium text-foreground">No sticky notes yet</h2>
          <p class="text-xs text-muted">Create a note to keep it handy across the app.</p>
        </div>
        <button
          type="button"
          class="flex items-center gap-1.5 border border-border bg-elevated px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-overlay disabled:opacity-50"
          title="Create a sticky note"
          aria-label="Create a sticky note"
          disabled={!stickyNotes.isLoaded}
          onclick={() => void createNote()}
        >
          <CioNotes size={13} />
          New sticky note
        </button>
        {#if createError}<p class="text-xs text-danger" role="alert">{createError}</p>{/if}
      </div>
    {:else}
      <PanelTabStrip
        {tabs}
        activeTabId={stickyNotes.activeNoteId}
        newLabel="New sticky note"
        trailing={stripMenu}
        onSelect={selectNote}
        onNew={() => void createNote()}
        onCloseTab={requestDelete}
        onMoveTab={(id, targetId, position) => stickyNotes.move(id, targetId, position)}
        onTabContextMenu={(id) => {
          const note = stickyNotes.note(id)
          if (!note) return
          selectNote(id)
          editNote(note)
        }}
        {tabIcon}
      >
        {#snippet actions()}{@render stripActions()}{/snippet}
      </PanelTabStrip>

      {#if activeNote}
        {@render noteBody(activeNote)}
      {/if}
      {#if createError}<p class="px-3.5 pb-2 text-xs text-danger" role="alert">
          {createError}
        </p>{/if}
    {/if}
  </div>
{/if}

{#if activeNote?.loaded && fullscreen}
  <FullscreenPanelDialog
    {tabs}
    activeTabId={stickyNotes.activeNoteId}
    newLabel="New sticky note"
    minimizeLabel="Exit fullscreen"
    trailing={stripMenu}
    onNew={() => void createNote()}
    onMinimize={() => toggleFullscreen(false)}
    onSelect={selectNote}
    onCloseTab={requestDelete}
    onMoveTab={(id, targetId, position) => stickyNotes.move(id, targetId, position)}
    onTabContextMenu={(id) => {
      const note = stickyNotes.note(id)
      if (!note) return
      selectNote(id)
      editNote(note)
    }}
    {tabIcon}
  >
    {#snippet actions()}{@render stripActions()}{/snippet}
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
