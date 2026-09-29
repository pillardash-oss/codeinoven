<script lang="ts">
  import {
    CircleStop,
    ExternalLink,
    FileDown,
    FolderOpen,
    Pause,
    Play,
    RotateCw,
    X
  } from '@lucide/svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import {
    browserDownloadAge,
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
  /**
   * Whether the row has a place worth continuing from, so its progress is shown
   * even while it is not running: a download the app or the server stopped keeps
   * the bytes it already has, and they are where a resume picks up.
   */
  const showsProgress = $derived(
    progressing || (download.state === 'interrupted' && download.resumable)
  )
  /** Resume is for a download with bytes to continue from: paused in this run, or
   *  stopped with the earlier bytes still on disk. */
  const canResume = $derived(
    (progressing && download.paused) || (download.state === 'interrupted' && download.resumable)
  )
  /** A download that is not running and not finished can be started over, into the
   *  same file, without asking for a path again. */
  const canRetry = $derived(download.state === 'interrupted' || download.state === 'cancelled')
  /** Only a finished download is opened; a stopped one has no complete file yet. */
  const canOpen = $derived(download.state === 'completed' && download.savePath !== '')
  /** Revealing works for anything that left a file or kept bytes behind. */
  const canReveal = $derived(download.state !== 'cancelled' && download.savePath !== '')
  const canRemove = $derived(!progressing)
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
    const parts = [browserDownloadHost(download.url)]
    if (download.receivedBytes > 0) {
      parts.push(
        showsProgress && download.totalBytes > 0
          ? `${browserDownloadBytes(download.receivedBytes)} of ${browserDownloadBytes(download.totalBytes)}`
          : browserDownloadBytes(download.receivedBytes)
      )
    }
    if (progressing && download.speedBytes > 0) {
      parts.push(`${browserDownloadBytes(download.speedBytes)}/s`)
    }
    // Downloads outlive the run that started them, so a stopped one says how old
    // it is instead of looking like something from a moment ago.
    const age = progressing ? '' : browserDownloadAge(download.startedAt)
    if (age.length > 0) parts.push(age)
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
        <button
          type="button"
          class={cancelButton}
          aria-label={`Cancel ${download.fileName}`}
          title={`Cancel ${download.fileName}`}
          onclick={() => browserDownloads.cancel(download)}
        >
          <CircleStop size={actionIcon} />
        </button>
      {:else}
        {#if canResume}
          <button
            type="button"
            class={actionButton}
            aria-label={`Resume ${download.fileName}`}
            title={`Resume ${download.fileName}`}
            onclick={() => browserDownloads.resume(download)}
          >
            <Play size={actionIcon} />
          </button>
        {/if}
        {#if canRetry}
          <button
            type="button"
            class={actionButton}
            aria-label={`Download ${download.fileName} again from the start`}
            title={`Start ${download.fileName} over`}
            onclick={() => browserDownloads.retry(download)}
          >
            <RotateCw size={actionIcon} />
          </button>
        {/if}
        {#if canOpen}
          <button
            type="button"
            class={actionButton}
            aria-label={`Open ${download.fileName}`}
            title={`Open ${download.fileName}`}
            onclick={() => browserDownloads.open(download)}
          >
            <ExternalLink size={actionIcon} />
          </button>
        {/if}
        {#if canReveal}
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
        {#if canRemove}
          <button
            type="button"
            class={actionButton}
            aria-label={`Remove ${download.fileName} from the downloads list`}
            title={`Remove ${download.fileName} from the list`}
            onclick={() => browserDownloads.remove(download)}
          >
            <X size={actionIcon} />
          </button>
        {/if}
      {/if}
    </div>
  </div>
  {#if showsProgress}
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
