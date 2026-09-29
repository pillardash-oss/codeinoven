<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import BrowserDownloadProgress from '$lib/components/browser/BrowserDownloadProgress.svelte'
  import {
    browserDownloadBytes,
    browserDownloadHost,
    browserDownloadStateLabel,
    browserDownloadTone
  } from '$lib/components/browser/browser-download-format'
  import type {
    BrowserDownload,
    CloseConfirmationPayload,
    CloseConfirmationProject,
    CloseConfirmationThread
  } from '$shared/ipc-contract'
  import type { Project } from '$shared/types'

  type CloseConfirmationFileProject = Pick<Project, 'id' | 'name' | 'path' | 'source' | 'host'>

  interface VisibleFileGroup {
    project: CloseConfirmationFileProject
    files: CloseConfirmationPayload['files']
  }

  interface Props {
    payload: CloseConfirmationPayload | null
    projects: readonly Project[]
    onDismiss: () => void
    onConfirm: () => void | Promise<void>
    /** Save every unsaved file, then close the app. */
    onConfirmSave?: () => void | Promise<void>
  }

  let { payload, projects, onDismiss, onConfirm, onConfirmSave = undefined }: Props = $props()

  const VISIBLE_PROJECTS = 2
  const VISIBLE_THREADS_PER_PROJECT = 3
  const VISIBLE_FILES = 6
  const VISIBLE_DOWNLOADS = 4

  let visibleProjects = $derived((payload?.projects ?? []).slice(0, VISIBLE_PROJECTS))
  let remainingProjectCount = $derived(
    Math.max(0, (payload?.projects.length ?? 0) - VISIBLE_PROJECTS)
  )
  let visibleFiles = $derived((payload?.files ?? []).slice(0, VISIBLE_FILES))
  let visibleFileGroups = $derived.by(() => {
    const groups: VisibleFileGroup[] = []

    for (const file of visibleFiles) {
      const project = projects.find((candidate) => candidate.id === file.projectId) ?? {
        id: file.projectId,
        // Files opened straight from the operating system belong to no project.
        name: file.projectId ? `Project ${file.projectId}` : 'Opened files',
        path: '',
        source: 'local' as const
      }
      const group = groups.find((candidate) => candidate.project.id === file.projectId)
      if (group) {
        group.files.push(file)
      } else {
        groups.push({ project, files: [file] })
      }
    }

    return groups
  })
  let remainingFileCount = $derived(Math.max(0, (payload?.files.length ?? 0) - VISIBLE_FILES))
  let hasFiles = $derived((payload?.files.length ?? 0) > 0)
  let hasThreads = $derived((payload?.projects.length ?? 0) > 0)
  let downloads = $derived(payload?.downloads ?? [])
  let visibleDownloads = $derived(downloads.slice(0, VISIBLE_DOWNLOADS))
  let remainingDownloadCount = $derived(Math.max(0, downloads.length - VISIBLE_DOWNLOADS))
  let hasDownloads = $derived(downloads.length > 0)

  /**
   * What closing now costs the user, in the order the sections above list it.
   * A download is the one pending thing a close does not cost anything: its
   * bytes stay on disk and it continues later, so on its own it reads as a
   * pause rather than a loss.
   */
  let closeCosts = $derived.by(() => {
    const costs: string[] = []
    if (hasThreads) costs.push('working threads will be interrupted')
    if (hasFiles) costs.push('unsaved changes will be lost')
    if (hasDownloads) {
      costs.push(
        costs.length === 0
          ? 'running downloads will pause and continue next time the app opens'
          : 'running downloads will pause'
      )
    }
    return sentenceCase(costs.join(' and '))
  })

  function sentenceCase(text: string): string {
    return text.length === 0 ? text : `${text[0].toUpperCase()}${text.slice(1)}`
  }

  /** The closing question with what it costs appended, as one string so the
   *  spacing never depends on where the markup happens to wrap. */
  let closeSentence = $derived(
    closeCosts.length === 0
      ? 'Are you sure you want to close?'
      : `Are you sure you want to close? ${closeCosts}.`
  )

  /** Where a download came from and how far it got. The host says which source a
   *  row belongs to when two files share a name, which is the only thing that
   *  tells them apart. */
  function downloadDetail(download: BrowserDownload): string {
    const parts = [browserDownloadHost(download.url)]
    if (download.receivedBytes > 0) {
      parts.push(
        download.totalBytes > 0
          ? `${browserDownloadBytes(download.receivedBytes)} of ${browserDownloadBytes(download.totalBytes)}`
          : browserDownloadBytes(download.receivedBytes)
      )
    }
    return parts.join(' · ')
  }

  /**
   * What closing does to the downloads above. It is the one consequence that is
   * not a loss, so it says where they continue rather than what the user loses,
   * and names the condition: continuing where it stopped needs a server that
   * serves ranges.
   */
  let downloadsNote = $derived.by(() => {
    const many = downloads.length > 1
    return `Closing ${many ? 'pauses them' : 'pauses it'} and keeps the bytes already downloaded. On a server that supports resuming, ${many ? 'they continue' : 'it continues'} where ${many ? 'they left' : 'it left'} off the next time you open the app.`
  })

  function visibleThreads(project: CloseConfirmationProject): CloseConfirmationThread[] {
    return project.threads.slice(0, VISIBLE_THREADS_PER_PROJECT)
  }
</script>

<Modal open={payload !== null} title="Close application?" onClose={onDismiss}>
  {#if payload}
    <div class="space-y-4">
      {#if hasThreads}
        <div class="space-y-2">
          <p class="text-sm text-muted">These threads are still working:</p>
          <ul class="space-y-2.5">
            {#each visibleProjects as project (project.projectId)}
              <li class="space-y-1">
                <div class="flex items-center gap-2 text-sm text-foreground">
                  <StatusBadge stage="working" animated size="sm" title="Working" />
                  <span class="min-w-0 truncate font-medium">{project.projectName}</span>
                  <span class="shrink-0 text-xs text-dimmed tabular-nums">
                    {project.threadCount}
                    {project.threadCount === 1 ? 'thread' : 'threads'}
                  </span>
                </div>
                <ul class="space-y-0.5 border-l border-border pl-3">
                  {#each visibleThreads(project) as thread (thread.threadId)}
                    <li class="flex items-center gap-1.5 text-xs text-muted">
                      <span class="shrink-0 uppercase tracking-wide text-dimmed">
                        {thread.status === 'executing' ? 'Executing' : 'Planning'}
                      </span>
                      <span class="min-w-0 truncate" title={thread.title}>{thread.title}</span>
                    </li>
                  {/each}
                  {#if project.threads.length > VISIBLE_THREADS_PER_PROJECT}
                    <li class="pl-0 text-xs text-dimmed">
                      +{project.threads.length - VISIBLE_THREADS_PER_PROJECT} more
                    </li>
                  {/if}
                </ul>
              </li>
            {/each}
            {#if remainingProjectCount > 0}
              <li class="pl-4 text-sm text-muted">
                +{remainingProjectCount} more {remainingProjectCount === 1 ? 'project' : 'projects'}
              </li>
            {/if}
          </ul>
        </div>
      {/if}

      {#if hasFiles}
        <div class="space-y-2">
          <p class="text-sm text-muted">These files have unsaved changes:</p>
          <ul class="space-y-2.5">
            {#each visibleFileGroups as group (group.project.id)}
              <li class="space-y-1">
                <ProjectIdentity
                  project={group.project}
                  class="pl-3"
                  nameClass="text-xs font-medium text-foreground"
                  locationClass="text-[0.625rem] text-dimmed"
                  showLocation
                />
                <ul class="space-y-0.5 border-l border-border pl-3">
                  {#each group.files as file (`${file.projectId}:${file.path}`)}
                    <li class="flex items-center gap-1.5 text-xs text-muted">
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
                      <span class="min-w-0 truncate font-mono" title={file.path}>{file.path}</span>
                    </li>
                  {/each}
                </ul>
              </li>
            {/each}
            {#if remainingFileCount > 0}
              <li class="pl-3 text-xs text-dimmed">
                +{remainingFileCount} more {remainingFileCount === 1 ? 'file' : 'files'}
              </li>
            {/if}
          </ul>
        </div>
      {/if}

      {#if hasDownloads}
        <div class="space-y-2">
          <p class="text-sm text-muted">These downloads have not finished:</p>
          <ul class="space-y-2.5">
            {#each visibleDownloads as download (download.id)}
              <li class="space-y-1">
                <div class="flex min-w-0 items-center gap-2 text-xs">
                  <span class="min-w-0 flex-1 truncate text-foreground" title={download.fileName}>
                    {download.fileName}
                  </span>
                  <span class="shrink-0 text-dimmed">{downloadDetail(download)}</span>
                  <StatusPill tone={browserDownloadTone(download)} dot>
                    {browserDownloadStateLabel(download)}
                  </StatusPill>
                </div>
                <BrowserDownloadProgress
                  percent={download.progress}
                  fileName={download.fileName}
                  class="pl-3"
                />
              </li>
            {/each}
            {#if remainingDownloadCount > 0}
              <li class="pl-3 text-xs text-dimmed">
                +{remainingDownloadCount} more
                {remainingDownloadCount === 1 ? 'download' : 'downloads'}
              </li>
            {/if}
          </ul>
          <p class="text-xs leading-relaxed text-dimmed">{downloadsNote}</p>
        </div>
      {/if}

      <p class="text-sm leading-relaxed text-muted">{closeSentence}</p>
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      class="shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Keep the app open"
      onclick={onDismiss}
    >
      Dismiss
    </button>
    {#if onConfirmSave && hasFiles}
      <button
        type="button"
        class="shrink-0 whitespace-nowrap rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
        title="Save all unsaved files and close the application"
        onclick={() => void onConfirmSave()}
      >
        Save &amp; close
      </button>
    {/if}
    <button
      type="button"
      class="shrink-0 whitespace-nowrap rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
      title="Close the application and interrupt working threads"
      onclick={() => void onConfirm()}
    >
      Close application
    </button>
  {/snippet}
</Modal>
