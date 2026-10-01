<script lang="ts">
  import type { Snippet } from 'svelte'
  import { fade } from 'svelte/transition'
  let { label, classes, children }: { label: string; classes: string; children: Snippet } = $props()
</script>

<span
  class="inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border px-2.5 py-1 text-[0.6875rem] font-medium {classes}"
  in:fade={{ duration: 150 }}
  title={label}
>
  {@render children()}
  <span class="truncate">{label}</span>
</span>
