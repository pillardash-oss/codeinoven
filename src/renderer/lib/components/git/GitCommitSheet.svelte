<script lang="ts">
  import { gitState } from '$lib/stores/git.svelte'
  import Modal from '../ui/Modal.svelte'
  import { GitCommit, Loader2 } from '@lucide/svelte'

  interface Props {
    projectId: string
    stagedCount: number
    onClose: () => void
    onCommitted: () => void
  }

  let { projectId, stagedCount, onClose, onCommitted }: Props = $props()

  let message = $state('')
  const committing = $derived(gitState.isBusy('commit'))

  async function commit(): Promise<void> {
    await gitState.commit(projectId, message)
    if (!gitState.error) onCommitted()
  }
</script>

<Modal open title="Commit changes" {onClose}>
  <div class="space-y-3">
    <p class="text-[11px] leading-relaxed text-muted">
      Commit {stagedCount} staged {stagedCount === 1 ? 'file' : 'files'} on the current branch.
    </p>
    <div>
      <label
        class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
        for="commit-message"
      >
        Commit message
      </label>
      <textarea
        id="commit-message"
        class="min-h-24 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder="Summarize the change…"
        bind:value={message}></textarea>
    </div>
    {#if gitState.error}
      <p
        class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
      >
        {gitState.error}
      </p>
    {/if}
  </div>
  {#snippet footer()}
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        class="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={!message.trim() || committing || stagedCount === 0}
        onclick={() => void commit()}
      >
        {#if committing}
          <Loader2 size={12} class="animate-spin" />
        {:else}
          <GitCommit size={12} />
        {/if}
        Commit
      </button>
    </div>
  {/snippet}
</Modal>
