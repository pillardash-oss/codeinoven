<script lang="ts">
  import { FileDown, Loader2 } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'

  interface Props {
    open: boolean
    /** True when the underlying conversation is a plain chat (no project tree). */
    chatMode: boolean
    onClose: () => void
    onExport: (includeTrace: boolean) => void | Promise<void>
  }

  let { open, chatMode, onClose, onExport }: Props = $props()

  /** Include the working trace (reasoning, tool calls, sub-agents) — off by default. */
  let includeTrace = $state(false)
  let busy = $state(false)

  function confirm(): void {
    if (busy) return
    busy = true
    void Promise.resolve(onExport(includeTrace))
      .catch(() => undefined)
      .finally(() => {
        busy = false
      })
  }
</script>

<Modal {open} title="Export transcript" {onClose}>
  <div class="flex flex-col gap-5">
    <p class="text-sm leading-relaxed text-muted">
      You are about to export this conversation as a Markdown transcript
      {chatMode ? 'to the temporary chat directory.' : 'inside the project’s .cio scratch space.'}
    </p>

    <div class="flex items-start gap-3 rounded-xl border bg-elevated px-3 py-3">
      <Switch
        checked={includeTrace}
        onchange={(value) => (includeTrace = value)}
        aria-label="Include working trace and tool calls"
        title="Include the working trace, tool calls, and all of that in the transcript"
      />
      <span class="min-w-0">
        <span class="block text-xs font-medium text-foreground">Include the working trace</span>
        <span class="block text-[11px] leading-snug text-dimmed">
          Tool calls, reasoning, and sub-agents become part of the transcript. Off by default so
          only the message and final output are included.
        </span>
      </span>
    </div>

    <p
      class="flex items-start gap-1.5 rounded-lg bg-elevated px-3 py-2 text-[11px] leading-snug text-muted"
    >
      <Loader2 size={12} class="mt-0.5 shrink-0 animate-spin text-accent" />
      The transcript is exported in the background on a worker thread — the app stays fully responsive
      and you can keep working while it runs. You'll get a notification when it's ready.
    </p>
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      disabled={busy}
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="button"
      class="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
      title="Export the transcript in the background"
      disabled={busy}
      onclick={confirm}
    >
      {#if busy}
        <Loader2 size={14} class="animate-spin" />
      {:else}
        <FileDown size={14} />
      {/if}
      Export transcript
    </button>
  {/snippet}
</Modal>
