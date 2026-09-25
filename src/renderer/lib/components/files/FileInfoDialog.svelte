<script lang="ts">
  import type { ProjectFileInfo } from '$shared/types'
  import { formatDateTime } from '$shared/date-time-format'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    info: ProjectFileInfo | null
    onClear: () => void
  }

  let { info, onClear }: Props = $props()
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
      <dd class="text-foreground">
        {info.size === undefined ? ' ' : `${info.size.toLocaleString()} bytes`}
      </dd>
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
      class="rounded-lg border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onClear}
    >
      Close
    </button>
  {/snippet}
</Modal>
