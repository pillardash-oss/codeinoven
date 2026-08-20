<script lang="ts">
  import { Redo2, SquarePen, Trash2, Undo2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { ThreadNoteContextTab } from '$lib/stores/context-sidebar.svelte'

  interface Props {
    tab: ThreadNoteContextTab
  }

  let { tab }: Props = $props()

  let showDeleteConfirm = $state(false)
  let historyController = $state<{ undo: () => void; redo: () => void } | null>(null)
  let canUndo = $state(false)
  let canRedo = $state(false)

  let hasContent = $derived(tab.draftBody.trim().length > 0)
  let dirty = $derived(tab.draftBody !== (tab.savedBody ?? ''))

  function startEdit(): void {
    tab.error = null
    tab.mode = 'edit'
  }

  function cancelEdit(): void {
    tab.error = null
    tab.draftBody = tab.savedBody ?? ''
    tab.mode = tab.savedBody !== null ? 'read' : 'edit'
  }

  async function saveNote(): Promise<void> {
    if (!dirty || !hasContent || tab.saving) return
    tab.saving = true
    tab.error = null
    try {
      const saved = await invoke('note:save', tab.projectId, tab.threadId, tab.draftBody)
      tab.savedBody = saved.body
      tab.draftBody = saved.body
      tab.mode = 'read'
    } catch (err) {
      tab.error = err instanceof Error ? err.message : 'Could not save the note'
    } finally {
      tab.saving = false
    }
  }

  async function confirmDelete(): Promise<void> {
    if (tab.saving) return
    tab.saving = true
    tab.error = null
    try {
      await invoke('note:delete', tab.projectId, tab.threadId)
      tab.savedBody = null
      tab.draftBody = ''
      tab.mode = 'edit'
      showDeleteConfirm = false
    } catch (err) {
      tab.error = err instanceof Error ? err.message : 'Could not delete the note'
    } finally {
      tab.saving = false
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  <div class="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
    {#if tab.mode === 'read'}
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Edit note"
        title="Edit note"
        onclick={startEdit}
      >
        <SquarePen size={13} />
        Edit
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Delete note"
        title={tab.savedBody === null ? 'No note to delete yet' : 'Delete this note'}
        disabled={tab.savedBody === null || tab.saving}
        onclick={() => (showDeleteConfirm = true)}
      >
        <Trash2 size={13} />
        Delete
      </button>
    {:else}
      <button
        type="button"
        class="rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Discard changes"
        title="Discard changes"
        disabled={tab.savedBody === null && !hasContent}
        onclick={cancelEdit}
      >
        Cancel
      </button>
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Undo note edit"
        title="Undo note edit"
        disabled={!historyController || !canUndo || tab.saving}
        onclick={() => historyController?.undo()}
      >
        <Undo2 size={13} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Redo note edit"
        title="Redo note edit"
        disabled={!historyController || !canRedo || tab.saving}
        onclick={() => historyController?.redo()}
      >
        <Redo2 size={13} />
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
        aria-label="Save note"
        title="Save note"
        disabled={!dirty || !hasContent || tab.saving}
        onclick={() => void saveNote()}
      >
        {tab.saving ? 'Saving…' : 'Save'}
      </button>
    {/if}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if tab.loading}
      <p class="py-10 text-center text-sm text-dimmed">Loading note…</p>
    {:else if tab.mode === 'edit'}
      {#key tab.focusRequest}
        <RichMarkdownEditor
          id="thread-note-body"
          value={tab.draftBody}
          onValueChange={(value) => (tab.draftBody = value)}
          placeholder="Remind yourself what you intended to do here — Markdown supported…"
          ariaLabel="Thread note"
          autofocus
          containerClass="min-h-full"
          class="min-h-full w-full px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
          onHistoryControllerChange={(controller) => (historyController = controller)}
          onHistoryStateChange={(state) => {
            canUndo = state.canUndo
            canRedo = state.canRedo
          }}
        />
      {/key}
    {:else if hasContent}
      <MarkdownView text={tab.draftBody} class="w-full px-3.5 py-3 text-sm leading-5" />
    {:else}
      <p class="px-3.5 py-3 text-sm leading-5 text-dimmed">Nothing written yet.</p>
    {/if}

    {#if tab.error}
      <p class="px-3.5 pb-3 text-sm text-danger">{tab.error}</p>
    {/if}
  </div>
</div>

{#if showDeleteConfirm}
  <Modal open title="Delete Note" onClose={() => (showDeleteConfirm = false)}>
    <p class="text-sm leading-relaxed text-muted">
      This will permanently delete the note on
      <span class="font-medium text-foreground">{tab.threadTitle || 'this thread'}</span>. This
      action cannot be undone.
    </p>

    {#snippet footer()}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
        onclick={() => (showDeleteConfirm = false)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={tab.saving}
        onclick={() => void confirmDelete()}
      >
        Delete
      </button>
    {/snippet}
  </Modal>
{/if}
