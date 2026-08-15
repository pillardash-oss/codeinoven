<script lang="ts">
  import { Eye, Trash2 } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import MarkdownView from '$lib/components/markdown/MarkdownView.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { ThreadNote } from '$shared/types'

  interface Props {
    open: boolean
    projectId: string
    threadId: string
    /** Display name of the owning thread, used in the delete confirmation. */
    threadTitle?: string
    onClose: () => void
  }

  let { open, projectId, threadId, threadTitle = '', onClose }: Props = $props()

  let bodyValue = $state('')
  let existing = $state<ThreadNote | null>(null)
  /** Read mode renders the note; edit mode shows the markdown editor. */
  let mode = $state<'edit' | 'read'>('edit')
  let loading = $state(false)
  let saving = $state(false)
  let showDeleteConfirm = $state(false)
  let error = $state<string | null>(null)

  let hasContent = $derived(bodyValue.trim().length > 0)

  $effect(() => {
    if (!open) return
    const targetThreadId = threadId
    void loadNote(targetThreadId)
  })

  async function loadNote(targetThreadId: string): Promise<void> {
    bodyValue = ''
    existing = null
    mode = 'edit'
    error = null
    loading = true
    try {
      const note = await invoke('note:get', projectId, targetThreadId)
      if (threadId !== targetThreadId) return
      existing = note
      bodyValue = note?.body ?? ''
      // A saved note opens in read mode so the user reads it, not its source.
      mode = note ? 'read' : 'edit'
    } catch (err) {
      if (threadId !== targetThreadId) return
      error = err instanceof Error ? err.message : 'Could not load the note'
    } finally {
      if (threadId === targetThreadId) loading = false
    }
  }

  async function saveNote(): Promise<void> {
    if (!hasContent || saving) return
    saving = true
    error = null
    try {
      existing = await invoke('note:save', projectId, threadId, bodyValue)
      mode = 'read'
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not save the note'
    } finally {
      saving = false
    }
  }

  async function confirmDelete(): Promise<void> {
    if (saving) return
    saving = true
    error = null
    try {
      await invoke('note:delete', projectId, threadId)
      showDeleteConfirm = false
      onClose()
    } catch (err) {
      error = err instanceof Error ? err.message : 'Could not delete the note'
      saving = false
    }
  }
</script>

<Modal {open} title="Notes" size="lg" {onClose}>
  {#if loading}
    <p class="py-10 text-center text-sm text-dimmed">Loading note…</p>
  {:else}
    <div class="space-y-3">
      <label class="text-xs font-medium text-muted" for="thread-note-body">Note</label>

      {#if mode === 'edit'}
        <RichMarkdownEditor
          id="thread-note-body"
          value={bodyValue}
          onValueChange={(value) => (bodyValue = value)}
          placeholder="Remind yourself what you intended to do here — Markdown supported…"
          ariaLabel="Thread note"
          autofocus={!existing}
          class="min-h-48 max-h-80 w-full overflow-y-auto px-3.5 pt-3 pb-1 text-sm leading-5 text-foreground outline-none"
        />
      {:else if hasContent}
        <MarkdownView
          text={bodyValue}
          class="min-h-48 max-h-80 w-full overflow-y-auto px-3.5 py-3 text-sm leading-5"
        />
      {:else}
        <p class="min-h-48 px-3.5 py-3 text-sm leading-5 text-dimmed">Nothing written yet.</p>
      {/if}

      {#if error}
        <p class="text-sm text-danger">{error}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-40"
      title={existing ? 'Delete this note' : 'No note to delete yet'}
      disabled={!existing || saving}
      onclick={() => (showDeleteConfirm = true)}
    >
      <Trash2 size={14} />
      Delete
    </button>
    <button
      type="button"
      class="ml-1 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={mode === 'edit' ? 'Read the note' : 'Edit the note'}
      title={mode === 'edit' ? 'Read the note' : 'Edit the note'}
      onclick={() => (mode = mode === 'edit' ? 'read' : 'edit')}
    >
      <Eye size={14} />
      <span class="whitespace-nowrap tabular-nums">
        <span class={mode === 'edit' ? 'text-foreground' : 'text-dimmed'}>read</span>
        <span class="mx-0.5 text-dimmed">|</span>
        <span class={mode === 'read' ? 'text-foreground' : 'text-dimmed'}>edit</span>
      </span>
    </button>
    <div class="flex-1"></div>
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
      disabled={!hasContent || saving}
      onclick={() => void saveNote()}
    >
      {saving ? 'Saving…' : 'Save'}
    </button>
  {/snippet}
</Modal>

{#if showDeleteConfirm}
  <Modal open title="Delete Note" onClose={() => (showDeleteConfirm = false)}>
    <p class="text-sm leading-relaxed text-muted">
      This will permanently delete the note on
      <span class="font-medium text-foreground">{threadTitle || 'this thread'}</span>. This action
      cannot be undone.
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
        disabled={saving}
        onclick={() => void confirmDelete()}
      >
        Delete
      </button>
    {/snippet}
  </Modal>
{/if}
