<script lang="ts">
  import { Plus, X } from '@lucide/svelte'
  import EditableMarkdown from './EditableMarkdown.svelte'

  interface Props {
    title: string
    items: string[]
    onEdit: (index: number, value: string) => void
    onAdd: () => void
    onRemove: (index: number) => void
  }

  let { title, items, onEdit, onAdd, onRemove }: Props = $props()
</script>

<div class="rounded-xl border bg-surface p-4">
  <div class="flex items-center justify-between">
    <h3 class="font-semibold">{title}</h3>
    <button
      class="rounded-md p-1 text-dimmed hover:bg-elevated hover:text-foreground"
      aria-label={`Add ${title.toLowerCase()}`}
      title={`Add ${title.toLowerCase()}`}
      onclick={onAdd}><Plus size={12} /></button
    >
  </div>
  <ul class="mt-2 space-y-1.5">
    {#each items as item, index (`${title}:${index}`)}
      <li class="group flex items-start gap-2 text-muted">
        <span>•</span>
        <EditableMarkdown
          class="min-w-0 flex-1 outline-none focus:text-foreground"
          text={item}
          ariaLabel={`${title} item ${index + 1}`}
          onChange={(value) => onEdit(index, value)}
        />
        <button
          class="rounded p-1 text-dimmed opacity-0 hover:text-danger group-hover:opacity-100"
          aria-label={`Remove ${title} item ${index + 1}`}
          title="Remove item"
          onclick={() => onRemove(index)}><X size={10} /></button
        >
      </li>
    {:else}
      <li class="text-muted">None recorded.</li>
    {/each}
  </ul>
</div>
