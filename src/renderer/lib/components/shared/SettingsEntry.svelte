<script lang="ts">
  import type { Snippet } from 'svelte'
  let { expanded = false, children }: { expanded?: boolean; children: Snippet } = $props()
</script>

<div
  class="rounded-xl border bg-surface p-4 transition-colors {expanded
    ? 'border-l-[3px] border-l-primary'
    : ''}"
>
  {@render children()}
</div>
