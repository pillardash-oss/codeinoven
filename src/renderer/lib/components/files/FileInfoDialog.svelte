<script lang="ts">
  import type { ProjectDirectorySize, ProjectFileInfo } from '$shared/types'
  import { formatDateTime } from '$shared/date-time-format'
  import { formatBytes } from '$lib/format/bytes'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    info: ProjectFileInfo | null
    /** What a folder holds, measured by the caller while the dialog is open.
     *  Null until that walk answers, or when it failed. */
    directorySize?: ProjectDirectorySize | null
    /** Whether that walk is still running. */
    directorySizePending?: boolean
    onClear: () => void
  }

  let { info, directorySize = null, directorySizePending = false, onClear }: Props = $props()

  /** "1,204 files · 87 folders", or the file count alone in a folder that holds
   *  no subfolders. */
  function contentSummary(size: ProjectDirectorySize): string {
    const files = `${size.files.toLocaleString()} ${size.files === 1 ? 'file' : 'files'}`
    if (size.directories === 0) return files
    const folders = `${size.directories.toLocaleString()} ${
      size.directories === 1 ? 'folder' : 'folders'
    }`
    return `${files} · ${folders}`
  }
</script>

<Modal
  open={info !== null}
  title="File info"
  description="Information about the selected project file"
  onClose={onClear}
  panelWidth="max-w-lg"
>
  {#if info}
    <dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
      <dt class="text-dimmed">Name</dt>
      <dd class="truncate text-foreground">{info.name}</dd>
      <dt class="text-dimmed">Path</dt>
      <dd class="break-all font-mono text-foreground">{info.absolutePath}</dd>
      <dt class="text-dimmed">Type</dt>
      <dd class="capitalize text-foreground">{info.kind}</dd>
      <dt class="text-dimmed">Size</dt>
      {#if info.kind === 'directory'}
        <dd class="text-foreground">
          {#if directorySizePending}
            <span class="text-dimmed">Measuring…</span>
          {:else if directorySize}
            <span title={`${directorySize.bytes.toLocaleString()} bytes`}>
              {formatBytes(directorySize.bytes)}
            </span>
            <span class="text-dimmed">· {contentSummary(directorySize)}</span>
            {#if directorySize.truncated}
              <span class="text-dimmed">· partial</span>
            {/if}
          {:else}
            <span class="text-dimmed">Unavailable</span>
          {/if}
        </dd>
      {:else}
        <dd
          class="text-foreground"
          title={info.size === undefined ? undefined : `${info.size.toLocaleString()} bytes`}
        >
          {info.size === undefined ? ' ' : formatBytes(info.size)}
        </dd>
      {/if}
      <dt class="text-dimmed">Modified</dt>
      <dd class="text-foreground">{formatDateTime(info.modifiedAt ?? 0)}</dd>
      <dt class="text-dimmed">Created</dt>
      <dd class="text-foreground">{formatDateTime(info.createdAt)}</dd>
    </dl>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onClear}
    >
      Close
    </button>
  {/snippet}
</Modal>
