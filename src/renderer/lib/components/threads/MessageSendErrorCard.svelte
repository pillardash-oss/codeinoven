<script lang="ts">
  import { AlertTriangle, Pencil } from '@lucide/svelte'

  interface Props {
    message: string
    onEdit: () => void
  }

  let { message, onEdit }: Props = $props()
</script>

<section
  class="mt-2 overflow-hidden rounded-lg border border-danger/30 bg-danger/5"
  role="alert"
  aria-label="Message not sent"
>
  <div class="flex items-center gap-2 border-b border-danger/20 px-3 py-2">
    <AlertTriangle size={14} class="shrink-0 text-danger" />
    <p class="text-xs font-semibold text-danger">Message not sent</p>
  </div>

  <div class="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
    <p class="min-w-0 flex-1 text-xs leading-relaxed text-muted">{message}</p>
    <button
      type="button"
      class="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
      title="Edit this message before sending it again"
      aria-label="Edit this message before sending it again"
      onclick={onEdit}
    >
      <Pencil size={12} />
      Edit message
    </button>
  </div>
</section>
