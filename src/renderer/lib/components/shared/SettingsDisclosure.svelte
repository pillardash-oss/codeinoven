<script lang="ts">
  import CioChevronDown from '$lib/components/icons/cio/CioChevronDown.svelte'

  let { expanded, title, onclick }: { expanded: boolean; title: string; onclick: () => void } =
    $props()
</script>

<button
  type="button"
  class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
  aria-expanded={expanded}
  {title}
  aria-label={title}
  {onclick}
>
  <CioChevronDown size={14} class="shrink-0 transition-transform {expanded ? 'rotate-180' : ''}" />
</button>
