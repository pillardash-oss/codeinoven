<script lang="ts">
  import {
    CircleStop,
    Download,
    ExternalLink,
    FileDown,
    FolderOpen,
    Pause,
    Play
  } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import {
    browserDownloadBytes,
    browserDownloadHost,
    browserDownloadStateLabel,
    browserDownloadTone
  } from './workspace-browser-downloads'
  import type { WorkspaceBrowserController } from './WorkspaceBrowserController.svelte'

  interface Props {
    browser: WorkspaceBrowserController
  }

  let { browser }: Props = $props()
</script>

<Modal
  open={browser.downloadsOpen}
  title="Browser downloads"
  onClose={() => browser.closeDownloads()}
  size="lg"
  contentClass="overflow-y-auto p-5"
  closeOnBackdrop={false}
>
  {#if browser.downloads.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 py-12 text-center text-dimmed">
      <Download size={20} strokeWidth={1.5} />
      <p class="text-xs">No downloads for this project yet.</p>
      <p class="text-[0.6875rem]">Files download to the location you pick in the save dialog.</p>
    </div>
  {:else}
    <ul class="space-y-2">
      {#each browser.downloads as download (download.id)}
        {@const progressing = download.state === 'progressing'}
        <li class="rounded-xl border border-border bg-elevated p-3">
          <div class="flex items-start gap-3">
            <div
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
            >
              <FileDown size={15} />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex min-w-0 items-center gap-2">
                <p
                  class="min-w-0 truncate text-sm font-medium text-foreground"
                  title={download.fileName}
                >
                  {download.fileName}
                </p>
                <StatusPill tone={browserDownloadTone(download)} dot title={download.state}>
                  {browserDownloadStateLabel(download)}
                </StatusPill>
              </div>
              <p class="mt-0.5 truncate text-[0.6875rem] text-muted" title={download.url}>
                {browserDownloadHost(download.url)} · {browserDownloadBytes(download.receivedBytes)}
                {progressing && download.totalBytes > 0
                  ? ` of ${browserDownloadBytes(download.totalBytes)}`
                  : ''}
              </p>
              {#if progressing && download.speedBytes > 0}
                <p class="mt-0.5 text-[0.6875rem] tabular-nums text-dimmed">
                  {browserDownloadBytes(download.speedBytes)}/s
                </p>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-1">
              {#if progressing}
                {#if download.paused}
                  <button
                    type="button"
                    class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                    aria-label={`Resume ${download.fileName}`}
                    title={`Resume ${download.fileName}`}
                    onclick={() => browser.resumeDownload(download)}
                  >
                    <Play size={13} />
                  </button>
                {:else}
                  <button
                    type="button"
                    class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                    aria-label={`Pause ${download.fileName}`}
                    title={`Pause ${download.fileName}`}
                    onclick={() => browser.pauseDownload(download)}
                  >
                    <Pause size={13} />
                  </button>
                {/if}
              {/if}
              {#if download.state === 'completed'}
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                  aria-label={`Open ${download.fileName}`}
                  title={`Open ${download.fileName}`}
                  onclick={() => browser.openDownload(download)}
                >
                  <ExternalLink size={13} />
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                  aria-label={`Reveal ${download.fileName} in file manager`}
                  title={`Reveal ${download.fileName} in file manager`}
                  onclick={() => browser.revealDownload(download)}
                >
                  <FolderOpen size={13} />
                </button>
              {/if}
              {#if progressing || download.state === 'interrupted'}
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-danger"
                  aria-label={`Cancel ${download.fileName}`}
                  title={`Cancel ${download.fileName}`}
                  onclick={() => browser.cancelDownload(download)}
                >
                  <CircleStop size={13} />
                </button>
              {/if}
            </div>
          </div>
          {#if progressing}
            {@const percent = Math.min(100, Math.max(0, download.progress))}
            <div class="mt-3 flex items-center gap-2">
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
        </li>
      {/each}
    </ul>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Close the downloads manager"
      onclick={() => browser.closeDownloads()}
    >
      Close
    </button>
  {/snippet}
</Modal>
