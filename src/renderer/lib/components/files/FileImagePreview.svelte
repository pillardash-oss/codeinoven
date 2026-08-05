<script lang="ts">
  import { Loader2 } from '@lucide/svelte'

  interface Props {
    src: string | null
    alt: string
    failed?: boolean
  }

  let { src, alt, failed = false }: Props = $props()
  let loadFailed = $state(false)
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
  {#if src}
    {#key src}
      <img
        {src}
        {alt}
        class="max-h-full max-w-full object-contain"
        onload={() => (loadFailed = false)}
        onerror={() => (loadFailed = true)}
      />
    {/key}
    {#if loadFailed}
      <p class="text-xs font-medium text-danger">This image could not be loaded</p>
    {/if}
  {:else if failed}
    <p class="text-xs font-medium text-danger">This image could not be loaded</p>
  {:else}
    <div class="flex items-center justify-center gap-2 text-[11px] text-dimmed">
      <Loader2 size={13} class="animate-spin" />
      Loading image preview
    </div>
  {/if}
</div>
