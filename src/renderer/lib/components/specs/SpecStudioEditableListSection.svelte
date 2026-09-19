<script lang="ts">
  import { Check, MessageSquarePlus, Plus, X } from '@lucide/svelte'
  import type { SpecAnnotation, SpecSectionId } from '$shared/types'
  import EditableMarkdown from './EditableMarkdown.svelte'
  import SpecStudioAnnotationBubbles from './SpecStudioAnnotationBubbles.svelte'

  interface Props {
    id: SpecSectionId
    title: string
    items: string[]
    annotations: SpecAnnotation[]
    onHeading: (section: SpecSectionId, event: MouseEvent) => void
    onEdit: (index: number, value: string) => void
    onAdd: () => void
    onRemove: (index: number) => void
    onOpenAnnotation: (annotation: SpecAnnotation) => void
  }

  let {
    id,
    title,
    items,
    annotations,
    onHeading,
    onEdit,
    onAdd,
    onRemove,
    onOpenAnnotation
  }: Props = $props()
</script>

<section id={`spec-section-${id}`} data-spec-section={id} class="scroll-mt-5">
  <div class="flex items-center justify-between gap-3">
    <button
      class="group flex items-center gap-2 text-left"
      title={`Annotate ${title}`}
      onclick={(event: MouseEvent) => onHeading(id, event)}
    >
      <span class="text-xl font-semibold tracking-tight">{title}</span>
      <MessageSquarePlus
        size={14}
        class="text-dimmed opacity-0 transition-opacity max-md:opacity-100 group-hover:opacity-100"
      />
    </button>
    <button
      class="flex items-center gap-1 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] text-muted hover:bg-overlay"
      title={`Add ${title.toLowerCase()} item`}
      onclick={onAdd}
    >
      <Plus size={11} />
      Add
    </button>
  </div>
  <ul class="mt-3 space-y-2">
    {#each items as item, index (`${id}:${index}`)}
      <li class="group flex items-start gap-2 rounded-lg px-2 py-1 text-muted hover:bg-surface">
        <Check size={13} class="mt-1.5 shrink-0 text-success" />
        <EditableMarkdown
          class="min-w-0 flex-1 outline-none focus:text-foreground"
          text={item}
          ariaLabel={`${title} item ${index + 1}`}
          onChange={(value) => onEdit(index, value)}
        />
        <button
          class="mt-0.5 rounded p-1 text-dimmed opacity-0 hover:bg-danger/10 hover:text-danger group-hover:opacity-100"
          aria-label={`Remove item ${index + 1}`}
          title={`Remove item ${index + 1}`}
          onclick={() => onRemove(index)}
        >
          <X size={11} />
        </button>
      </li>
    {:else}
      <li class="text-muted">Not defined.</li>
    {/each}
  </ul>
  <SpecStudioAnnotationBubbles {annotations} onOpen={onOpenAnnotation} />
</section>
