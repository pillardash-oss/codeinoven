<script lang="ts">
  import CioEye from '@pillardash-oss/cio-icon/CioEye.svelte'
  import CioEyeOff from '@pillardash-oss/cio-icon/CioEyeOff.svelte'
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
  class="flex h-8 w-8 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
  aria-pressed={revealed}
  {title}
  aria-label={title}
  {disabled}
  {onclick}
>
  {#if revealed}<CioEyeOff size={14} />{:else}<CioEye size={14} />{/if}
</button>
