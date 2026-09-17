<script lang="ts">
  import type { SpecAnnotation } from '$shared/types'

  interface Props {
    annotations: SpecAnnotation[]
    onOpen: (annotation: SpecAnnotation) => void
  }

  let { annotations, onOpen }: Props = $props()
</script>

{#if annotations.length}
  <div class="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Section annotations">
    {#each annotations as annotation (annotation.id)}
      <button
        class="max-w-64 shrink-0 rounded-xl border bg-surface px-3 py-2 text-left hover:bg-elevated"
        title="Open annotation"
        onclick={() => onOpen(annotation)}
      >
        <span class="line-clamp-2 text-xs leading-relaxed">{annotation.body}</span>
        <span class="mt-1 block text-[0.625rem] text-dimmed">{annotation.author}</span>
      </button>
    {/each}
  </div>
{/if}
