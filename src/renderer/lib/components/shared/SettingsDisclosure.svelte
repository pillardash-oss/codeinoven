<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  let { expanded, title, onclick }: { expanded: boolean; title: string; onclick: () => void } =
    $props()
</script>

<button
  type="button"
  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
  aria-expanded={expanded}
  {title}
  aria-label={title}
  {onclick}
>
  <ChevronDown size={14} class="shrink-0 transition-transform {expanded ? 'rotate-180' : ''}" />
</button>
