<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioExternalLink from '@pdslng/cio-icon/CioExternalLink.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import { copyText } from '$lib/copy-text'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import BrowserDownloadProgress from './BrowserDownloadProgress.svelte'
  import {
    browserDownloadDetail,
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
  /** A stopped or slow download can be handed to a real download manager, which
   *  needs nothing more than the address it is downloading from. */
  const canCopyUrl = $derived(download.url.length > 0)
  /** Revealing works for anything that left a file or kept bytes behind. */
  const canReveal = $derived(download.state !== 'cancelled' && download.savePath !== '')
  const canRemove = $derived(!progressing)
  const percent = $derived(Math.min(100, Math.max(0, download.progress)))
  const actionButton = $derived(
    `flex shrink-0 items-center justify-center text-muted transition-colors hover:bg-overlay hover:text-foreground ${
      compact ? 'h-6 w-6' : 'h-7 w-7'
    }`
  )
  const cancelButton = $derived(
    `flex shrink-0 items-center justify-center text-muted transition-colors hover:bg-overlay hover:text-danger ${
      compact ? 'h-6 w-6' : 'h-7 w-7'
    }`
  )
  const actionIcon = $derived(compact ? 12 : 13)
  const detail = $derived(browserDownloadDetail(download))
  /** Hand the address to whoever wants it: a user pasting it into a download
   *  manager gets the same file without the app's speed or reach. */
  function copyUrl(): void {
    void copyText(download.url, 'Download link copied')
  }
</script>

<div class={compact ? 'flex flex-col gap-1.5 px-3 py-2' : 'border border-border bg-elevated p-3'}>
  <div class="flex items-start gap-3">
    {#if !compact}
      <div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center bg-raised text-muted">
        <CioDownload size={15} />
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
            <CioPlay size={actionIcon} />
          </button>
        {:else}
          <button
            type="button"
            class={actionButton}
            aria-label={`Pause ${download.fileName}`}
            title={`Pause ${download.fileName}`}
            onclick={() => browserDownloads.pause(download)}
          >
            <CioPause size={actionIcon} />
          </button>
        {/if}
        {#if canCopyUrl}
          <button
            type="button"
            class={actionButton}
            aria-label={`Copy the link for ${download.fileName}`}
            title={`Copy ${download.fileName} link`}
            onclick={copyUrl}
          >
            <CioCopy size={actionIcon} />
          </button>
        {/if}
        <button
          type="button"
          class={cancelButton}
          aria-label={`Cancel ${download.fileName}`}
          title={`Cancel ${download.fileName}`}
          onclick={() => browserDownloads.cancel(download)}
        >
          <CioStop size={actionIcon} />
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
            <CioPlay size={actionIcon} />
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
            <CioRefresh size={actionIcon} />
          </button>
        {/if}
        {#if canCopyUrl}
          <button
            type="button"
            class={actionButton}
            aria-label={`Copy the link for ${download.fileName}`}
            title={`Copy ${download.fileName} link`}
            onclick={copyUrl}
          >
            <CioCopy size={actionIcon} />
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
            <CioExternalLink size={actionIcon} />
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
            <CioFolderOpen size={actionIcon} />
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
            <CioClose size={actionIcon} />
          </button>
        {/if}
      {/if}
    </div>
  </div>
  {#if showsProgress}
    <BrowserDownloadProgress {percent} fileName={download.fileName} class={compact ? '' : 'mt-3'} />
  {/if}
  {#if download.error}
    <p class="mt-2 text-[0.6875rem] text-danger" role="alert">{download.error}</p>
  {/if}
</div>
