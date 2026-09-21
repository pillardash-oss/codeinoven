<script lang="ts">
  import { Dialog } from 'bits-ui'
  import type { ProjectFileInfo } from '$shared/types'

  interface Props {
    info: ProjectFileInfo | null
    onClear: () => void
  }

  let { info, onClear }: Props = $props()
</script>

<Dialog.Root open={info !== null} onOpenChange={(open) => !open && onClear()}>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <Dialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(30rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <Dialog.Title class="text-sm font-semibold text-foreground">File info</Dialog.Title>
      <Dialog.Description class="sr-only"
        >Information about the selected project file</Dialog.Description
      >
      {#if info}
        <dl class="mt-4 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-xs">
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
          <dd class="text-foreground">{new Date(info.modifiedAt ?? 0).toLocaleString()}</dd>
          <dt class="text-dimmed">Created</dt>
          <dd class="text-foreground">{new Date(info.createdAt).toLocaleString()}</dd>
        </dl>
      {/if}
      <div class="mt-5 flex justify-end">
        <Dialog.Close
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Close
        </Dialog.Close>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
