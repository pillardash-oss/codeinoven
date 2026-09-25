<script lang="ts">
  import { CircleStop, ExternalLink, FileDown, FolderOpen, Pause, Play } from '@lucide/svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import {
    browserDownloadBytes,
    browserDownloadHost,
    browserDownloadStateLabel,
    browserDownloadTone
  } from './browser-download-format'
  import type { BrowserDownload } from '$shared/ipc-contract'

  interface Props {
    download: BrowserDownload
    /** Tighter layout for the anchored toolbar list; the downloads window uses
     *  the roomy card variant. */
    compact?: boolean
  }

  let { download, compact = false }: Props = $props()

  const progressing = $derived(download.state === 'progressing')
  /** Main only knows the file's final location once the save dialog answered and
   *  the download finished, so revealing is offered exactly then. */
  const canReveal = $derived(download.state === 'completed' && download.savePath !== '')
  const percent = $derived(Math.min(100, Math.max(0, download.progress)))
  const actionButton = $derived(
    `flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground ${
      compact ? 'h-6 w-6' : 'h-7 w-7'
    }`
  )
  const cancelButton = $derived(
    `flex shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-danger ${
      compact ? 'h-6 w-6' : 'h-7 w-7'
    }`
  )
  const actionIcon = $derived(compact ? 12 : 13)
  const detail = $derived.by(() => {
    const parts = [browserDownloadHost(download.url), browserDownloadBytes(download.receivedBytes)]
    if (progressing && download.totalBytes > 0) {
      parts.push(`of ${browserDownloadBytes(download.totalBytes)}`)
    }
    if (progressing && download.speedBytes > 0) {
      parts.push(`${browserDownloadBytes(download.speedBytes)}/s`)
    }
    return parts.join(' · ')
  })
</script>

<div
  class={compact
    ? 'flex flex-col gap-1.5 px-3 py-2'
    : 'rounded-xl border border-border bg-elevated p-3'}
>
  <div class="flex items-start gap-3">
    {#if !compact}
      <div
        class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
      >
        <FileDown size={15} />
      </div>
    {/if}
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        {#if canReveal}
          <button
            type="button"
            class="min-w-0 flex-1 truncate text-left text-sm font-medium text-foreground transition-colors hover:text-primary"
            title={`Reveal ${download.fileName} in file manager`}
            aria-label={`Reveal ${download.fileName} in file manager`}
            onclick={() => browserDownloads.reveal(download)}
          >
            {download.fileName}
          </button>
        {:else}
          <p
            class="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
            title={download.fileName}
          >
            {download.fileName}
          </p>
        {/if}
        <StatusPill tone={browserDownloadTone(download)} dot title={download.state}>
          {browserDownloadStateLabel(download)}
        </StatusPill>
      </div>
      <p class="mt-0.5 min-w-0 truncate text-[0.6875rem] text-muted" title={download.url}>
        {detail}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-1">
      {#if progressing}
        {#if download.paused}
          <button
            type="button"
            class={actionButton}
            aria-label={`Resume ${download.fileName}`}
            title={`Resume ${download.fileName}`}
            onclick={() => browserDownloads.resume(download)}
          >
            <Play size={actionIcon} />
          </button>
        {:else}
          <button
            type="button"
            class={actionButton}
            aria-label={`Pause ${download.fileName}`}
            title={`Pause ${download.fileName}`}
            onclick={() => browserDownloads.pause(download)}
          >
            <Pause size={actionIcon} />
          </button>
        {/if}
      {/if}
      {#if download.state === 'completed'}
        <button
          type="button"
          class={actionButton}
          aria-label={`Open ${download.fileName}`}
          title={`Open ${download.fileName}`}
          onclick={() => browserDownloads.open(download)}
        >
          <ExternalLink size={actionIcon} />
        </button>
        <button
          type="button"
          class={actionButton}
          aria-label={`Reveal ${download.fileName} in file manager`}
          title={`Reveal ${download.fileName} in file manager`}
          onclick={() => browserDownloads.reveal(download)}
        >
          <FolderOpen size={actionIcon} />
        </button>
      {/if}
      {#if progressing || download.state === 'interrupted'}
        <button
          type="button"
          class={cancelButton}
          aria-label={`Cancel ${download.fileName}`}
          title={`Cancel ${download.fileName}`}
          onclick={() => browserDownloads.cancel(download)}
        >
          <CircleStop size={actionIcon} />
        </button>
      {/if}
    </div>
  </div>
  {#if progressing}
    <div class={compact ? 'flex items-center gap-2' : 'mt-3 flex items-center gap-2'}>
      <div
        class="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-overlay"
        role="progressbar"
        aria-label={`Download progress for ${download.fileName}`}
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150"
          style={`width: ${percent}%`}
        ></div>
      </div>
      <span class="w-9 shrink-0 text-right text-[0.625rem] tabular-nums text-dimmed">
        {Math.round(percent)}%
      </span>
    </div>
  {/if}
  {#if download.error}
    <p class="mt-2 text-[0.6875rem] text-danger" role="alert">{download.error}</p>
  {/if}
</div>
