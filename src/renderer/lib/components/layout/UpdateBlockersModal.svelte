<script lang="ts">
  import CioAlertCircle from '@pdslng/cio-icon/CioAlertCircle.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import WorkingThreadList from '$lib/components/shared/WorkingThreadList.svelte'
  import BrowserDownloadProgress from '$lib/components/browser/BrowserDownloadProgress.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import {
    browserDownloadDetail,
    browserDownloadStateLabel,
    browserDownloadTone
  } from '$lib/components/browser/browser-download-format'
  import { updateBlockers } from '$lib/stores/update-blockers.svelte'
  import type { UpdateBlockers } from '$shared/ipc-contract'

  interface Props {
    /** Null while the modal is closed. */
    payload: UpdateBlockers | null
    onDismiss: () => void
  }

  let { payload, onDismiss }: Props = $props()

  const VISIBLE_TERMINALS = 6
  const VISIBLE_DOWNLOADS = 4

  let hasThreads = $derived((payload?.projects.length ?? 0) > 0)
  let terminals = $derived(payload?.terminals ?? [])
  let visibleTerminals = $derived(terminals.slice(0, VISIBLE_TERMINALS))
  let remainingTerminalCount = $derived(Math.max(0, terminals.length - VISIBLE_TERMINALS))
  let hasTerminals = $derived(terminals.length > 0)
  let downloads = $derived(payload?.downloads ?? [])
  let visibleDownloads = $derived(downloads.slice(0, VISIBLE_DOWNLOADS))
  let remainingDownloadCount = $derived(Math.max(0, downloads.length - VISIBLE_DOWNLOADS))
  let hasDownloads = $derived(downloads.length > 0)
  let hasListings = $derived(hasThreads || hasTerminals || hasDownloads)
  let forcing = $derived(updateBlockers.forcing)
  let failure = $derived(updateBlockers.failure)

  /**
   * What stopping this costs, in the order the sections above list it.
   *
   * Unlike the close gate, nothing here pauses instead of stopping: a thread
   * interrupted mid-turn comes back as a failed turn to retry, and a shell is
   * closed for good. A download is the exception the close gate already draws:
   * its bytes are kept and the next launch continues it, so it is named as a
   * pause rather than left unexplained.
   */
  let costs = $derived.by(() => {
    const parts: string[] = []
    if (hasThreads) parts.push('working threads stop mid-turn')
    if (hasTerminals) parts.push('running terminals close')
    if (hasDownloads) parts.push('running downloads pause and continue next time')
    if (parts.length === 0) return ''
    const listed =
      parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    return `${listed}.`
  })

  let restartSentence = $derived(
    payload?.version ? `The app restarts to apply version ${payload.version}.` : 'The app restarts.'
  )

  /**
   * The one case where the lists and the gate disagree is worth saying out loud.
   *
   * The count comes from live session state and the lists from thread rows and
   * pty handles, so they can differ while a status settles. A non-zero count with
   * nothing listed means the app is waiting on a session it cannot name, which is
   * exactly what the force install is for and would otherwise read as a modal
   * about nothing.
   */
  let unnamedSentence = $derived(
    !hasListings && (payload?.activeCount ?? 0) > 0
      ? `The update is waiting on ${payload?.activeCount} session${
          payload?.activeCount === 1 ? '' : 's'
        } with no thread or terminal to show.`
      : ''
  )

  /** What installing does to the downloads above: a pause with the bytes kept,
   *  not a loss, so it says where they continue instead of what it costs. */
  let downloadsNote = $derived.by(() => {
    const many = downloads.length > 1
    return `Installing ${many ? 'pauses them' : 'pauses it'} and keeps the bytes already downloaded. On a server that supports resuming, ${many ? 'they continue' : 'it continues'} where ${many ? 'they left' : 'it left'} off the next time you open the app.`
  })
</script>

<Modal open={payload !== null} title="Update waiting on active work" size="lg" onClose={onDismiss}>
  {#if payload}
    <div class="space-y-4">
      {#if failure}
        <p class="flex items-start gap-2 text-sm leading-relaxed text-danger" role="alert">
          <CioAlertCircle size={14} class="mt-0.5 shrink-0" />
          <span>{failure}</span>
        </p>
      {/if}

      {#if hasThreads}
        <WorkingThreadList projects={payload.projects} />
      {/if}

      {#if hasTerminals}
        <div class="space-y-2">
          <p class="text-sm text-muted">These terminals are still running:</p>
          <ul class="space-y-1.5">
            {#each visibleTerminals as terminal (terminal.sessionId)}
              <li class="flex items-center gap-2 text-xs text-muted">
                <CioTerminal size={13} class="shrink-0 text-dimmed" />
                <span class="shrink-0 font-medium text-foreground">{terminal.shell}</span>
                <span class="min-w-0 truncate font-mono text-dimmed" title={terminal.cwd}>
                  {terminal.cwd}
                </span>
              </li>
            {/each}
            {#if remainingTerminalCount > 0}
              <li class="pl-5 text-xs text-dimmed">+{remainingTerminalCount} more</li>
            {/if}
          </ul>
        </div>
      {/if}

      {#if hasDownloads}
        <div class="space-y-2">
          <p class="text-sm text-muted">These downloads are still running:</p>
          <ul class="space-y-2.5">
            {#each visibleDownloads as download (download.id)}
              <li class="space-y-1">
                <div class="flex min-w-0 items-center gap-2 text-xs">
                  <CioDownload size={13} class="shrink-0 text-dimmed" />
                  <span class="min-w-0 flex-1 truncate text-foreground" title={download.fileName}>
                    {download.fileName}
                  </span>
                  <span class="shrink-0 text-dimmed">{browserDownloadDetail(download)}</span>
                  <StatusPill tone={browserDownloadTone(download)} dot>
                    {browserDownloadStateLabel(download)}
                  </StatusPill>
                </div>
                <BrowserDownloadProgress
                  percent={download.progress}
                  fileName={download.fileName}
                  class="pl-5"
                />
              </li>
            {/each}
            {#if remainingDownloadCount > 0}
              <li class="pl-5 text-xs text-dimmed">
                +{remainingDownloadCount} more
                {remainingDownloadCount === 1 ? 'download' : 'downloads'}
              </li>
            {/if}
          </ul>
          <p class="text-xs leading-relaxed text-dimmed">{downloadsNote}</p>
        </div>
      {/if}

      {#if unnamedSentence}
        <p class="text-sm text-muted">{unnamedSentence}</p>
      {/if}

      {#if costs}
        <p class="text-sm leading-relaxed text-muted">
          Installing now: {costs.toLowerCase()}
          {restartSentence}
        </p>
      {:else if !unnamedSentence && !failure}
        <p class="text-sm leading-relaxed text-muted">{restartSentence}</p>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="shrink-0 whitespace-nowrap px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Keep waiting for the active work instead of installing now"
      onclick={onDismiss}
    >
      Keep waiting
    </button>
    <button
      type="button"
      data-modal-primary
      class="inline-flex shrink-0 items-center gap-2 whitespace-nowrap bg-danger px-4 py-2 text-sm font-medium text-on-danger transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-60"
      title={failure
        ? 'Stop everything listed above and try the install again'
        : 'Stop everything listed above and install the update now'}
      disabled={forcing}
      onclick={() => void updateBlockers.forceInstall()}
    >
      {#if forcing}
        <CioSpinner size={14} class="animate-spin" />
      {/if}
      <span
        >{forcing ? 'Stopping work' : failure ? 'Try install again' : 'Stop work & install'}</span
      >
    </button>
  {/snippet}
</Modal>
