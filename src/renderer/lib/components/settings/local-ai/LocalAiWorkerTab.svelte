<script lang="ts">
  import LocalAiRuntimeRow from './LocalAiRuntimeRow.svelte'
  import type { LocalAiRuntimeSummary } from '$shared/llama-cpp'

  interface Props {
    runtime: LocalAiRuntimeSummary
  }

  let { runtime }: Props = $props()

  /** What this engine can load here today. The worker serves the app's own
   *  speech models, so the list is stated rather than empty-handed. */
  const serves = $derived(
    runtime.id === 'mlx'
      ? ['Speech to text', 'Speech synthesis']
      : runtime.id === 'coreml'
        ? ['Speech to text']
        : []
  )
  const installed = $derived(runtime.available)
  const modelCount = $derived(serves.length)
</script>

<div class="space-y-3">
  <LocalAiRuntimeRow {runtime} icon="apple" />

  <section class="border bg-surface">
    <header class="flex items-center justify-between gap-3 border-b px-3 py-2">
      <h2 class="text-xs font-semibold">Models</h2>
      <span class="text-xs text-dimmed">{modelCount} {modelCount === 1 ? 'model' : 'models'}</span>
    </header>
    {#if !installed}
      <p class="px-3 py-6 text-xs text-muted">
        This engine is not available on this machine, so no model runs on it here.
      </p>
    {:else}
      <ul class="divide-y">
        {#each serves as name (name)}
          <li class="flex items-center justify-between gap-3 px-3 py-2 text-xs">
            <span class="text-foreground">{name}</span>
            <span class="text-dimmed">Bundled</span>
          </li>
        {/each}
      </ul>
      <p class="border-t px-3 py-2 text-xs text-dimmed">
        Loaded by the speech worker and released on its own idle window, not the shared llama.cpp
        one.
      </p>
    {/if}
  </section>
</div>
