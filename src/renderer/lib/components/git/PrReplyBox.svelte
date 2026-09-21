<script lang="ts">
  /**
   * The reply composer for one conversation entry.
   *
   * It owns only the draft and the busy state around it; what a reply means is
   * the caller's business, because GitHub threads a reply to an inline comment
   * while a conversation comment can only be answered with a new comment that
   * quotes it. The caller passes that difference in as `hint` so the reader is
   * never surprised by where their words land.
   */
  import { Loader2, Send } from '@lucide/svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'

  interface Props {
    /** The login being answered, for the placeholder and the accessible name. */
    recipient: string
    /** One line under the editor explaining how this reply is filed. */
    hint?: string
    busy?: boolean
    /** Post the reply. Returning false keeps the draft so nothing is lost. */
    onSubmit: (body: string) => Promise<boolean>
    onCancel: () => void
  }

  let { recipient, hint = '', busy = false, onSubmit, onCancel }: Props = $props()

  let body = $state('')
  const ready = $derived(body.trim().length > 0)

  async function submit(): Promise<void> {
    if (!ready || busy) return
    const draft = body.trim()
    const posted = await onSubmit(draft)
    if (posted) body = ''
  }
</script>

<div class="rounded-lg border border-border bg-elevated/40 p-1.5">
  <RichMarkdownEditor
    bind:value={body}
    placeholder="Reply to @{recipient}…"
    ariaLabel="Reply to @{recipient}"
    autofocus
    disabled={busy}
    containerClass="rounded-md border border-border bg-surface focus-within:border-primary"
    class="max-h-40 min-h-16 w-full overflow-y-auto px-2.5 pt-2 pb-1 text-[0.6875rem] leading-relaxed text-foreground outline-none"
    onSubmit={() => void submit()}
  />
  <div class="mt-1.5 flex items-center justify-between gap-2">
    <p class="min-w-0 truncate text-[0.5625rem] text-dimmed">
      {#if hint}
        {hint}
      {:else}
        Replying to @{recipient}
      {/if}
    </p>
    <div class="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        class="h-7 cursor-pointer rounded-lg border border-border px-2.5 text-[0.6875rem] text-foreground hover:bg-elevated"
        title="Discard this reply"
        disabled={busy}
        onclick={onCancel}
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
        title="Post this reply"
        disabled={!ready || busy}
        onclick={() => void submit()}
      >
        {#if busy}
          <Loader2 size={12} class="animate-spin" />
          Posting…
        {:else}
          <Send size={12} />
          Reply
        {/if}
      </button>
    </div>
  </div>
</div>
