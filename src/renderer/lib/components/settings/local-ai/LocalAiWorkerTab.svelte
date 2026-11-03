<script lang="ts">
  import LocalAiRuntimeRow from './LocalAiRuntimeRow.svelte'
  import type { LocalAiRuntimeSummary } from '$shared/llama-cpp'

  interface Props {
    runtime: LocalAiRuntimeSummary
  }

  let { runtime }: Props = $props()

  /** The models this engine serves on this machine. */
  const serves = $derived(
    runtime.id === 'mlx'
      ? ['Speech to text', 'Speech synthesis']
      : runtime.id === 'coreml'
        ? ['Speech to text']
        : []
  )
</script>

<div class="space-y-4">
  <LocalAiRuntimeRow {runtime} icon="apple" />

  <section>
    <div class="mb-2 flex items-end justify-between gap-4">
      <h2 class="text-sm font-semibold">Models</h2>
      <span class="text-xs text-dimmed">{serves.length}</span>
    </div>
    {#if !runtime.available}
      <div class="border border-dashed px-4 py-8 text-center">
        <p class="text-sm text-muted">This engine is not available on this machine.</p>
      </div>
    {:else}
      <ul class="space-y-2">
        {#each serves as name (name)}
          <li class="flex items-center justify-between gap-3 border bg-surface px-3 py-2 text-xs">
            <span class="text-foreground">{name}</span>
            <span class="text-dimmed">Bundled</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
