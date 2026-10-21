<script lang="ts">
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { formatBytes } from '$lib/format/bytes'
  interface Props {
    /** Model label, so every control names the model it acts on. */
    label: string
    /** What happened: "Download cancelled." or the failure's own message. */
    message: string
    /** Bytes kept on disk that a resume continues from. 0 when nothing survived. */
    keptBytes: number
    /** Size of the whole artifact, so kept bytes can be read against it. */
    totalBytes: number
    /** `cancelled` reads as a pause the user can pick up; `failed` as an error. */
    tone: 'cancelled' | 'failed'
    /** A resume or restart was requested and is waiting on the first progress event. */
    busy?: boolean
    onResume: () => void
    onRestart: () => void
  }

  let {
    label,
    message,
    keptBytes,
    totalBytes,
    tone,
    busy = false,
    onResume,
    onRestart
  }: Props = $props()

  /**
   * Nothing to continue from means resuming and restarting are the same request,
   * so one button does it and says plainly which it is.
   */
  const resumable = $derived(keptBytes > 0)
  const keptDetail = $derived(
    resumable && totalBytes > 0
      ? `${formatBytes(keptBytes)} of ${formatBytes(totalBytes)} kept on disk.`
      : resumable
        ? `${formatBytes(keptBytes)} kept on disk.`
        : ''
  )
  const singleAction = $derived(tone === 'failed' ? 'Retry' : 'Download')
</script>

<div
  class="flex items-start justify-between gap-3 border px-3 py-2 {tone === 'failed'
    ? 'border-danger/20 bg-danger/5'
    : 'border-border bg-muted/10'}"
>
  <p
    class="min-w-0 flex-1 text-[0.6875rem] leading-snug {tone === 'failed'
      ? 'text-danger'
      : 'text-muted'}"
  >
    {message}
    {#if keptDetail}
      <span class="text-dimmed">{keptDetail}</span>
    {/if}
  </p>
  <div class="flex shrink-0 items-center gap-1.5">
    {#if resumable}
      <button
        type="button"
        class="border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
        title="Start the {label} download over from the beginning"
        aria-label="Restart the {label} download from the beginning"
        disabled={busy}
        onclick={onRestart}
      >
        Restart
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        title="Resume the {label} download from {formatBytes(keptBytes)}"
        aria-label="Resume the {label} download"
        disabled={busy}
        onclick={onResume}
      >
        {#if busy}
          <CioSpinner size={11} class="animate-spin shrink-0" aria-hidden="true" />
        {:else}
          <CioPlay size={11} aria-hidden="true" />
        {/if}
        Resume
      </button>
    {:else}
      <button
        type="button"
        class="flex items-center gap-1.5 bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        title="{singleAction} {label}"
        aria-label="{singleAction} {label}"
        disabled={busy}
        onclick={onResume}
      >
        {#if busy}
          <CioSpinner size={11} class="animate-spin shrink-0" aria-hidden="true" />
        {:else}
          <CioDownload size={11} aria-hidden="true" />
        {/if}
        {singleAction}
      </button>
    {/if}
  </div>
</div>
