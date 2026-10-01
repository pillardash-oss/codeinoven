<script lang="ts">
  import { Eye, EyeOff } from '@lucide/svelte'
  let {
    revealed,
    title,
    disabled = false,
    onclick
  }: {
    revealed: boolean
    title: string
    disabled?: boolean
    onclick: () => void
  } = $props()
</script>

<button
  type="button"
  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
  aria-pressed={revealed}
  {title}
  aria-label={title}
  {disabled}
  {onclick}
>
  {#if revealed}<EyeOff size={14} />{:else}<Eye size={14} />{/if}
</button>
