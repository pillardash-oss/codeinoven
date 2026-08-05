<script lang="ts">
  import { Loader2 } from '@lucide/svelte'

  interface Props {
    src: string | null
    alt: string
    kind: 'video' | 'audio'
    failed?: boolean
  }

  let { src, alt, kind, failed = false }: Props = $props()
  let loadFailed = $state(false)
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
  {#if src}
    {#key src}
      {#if kind === 'video'}
        <video
          {src}
          controls
          preload="metadata"
          class="max-h-full max-w-full"
          onerror={() => (loadFailed = true)}
        >
          <track kind="captions" />
        </video>
      {:else}
        <audio
          {src}
          controls
          preload="metadata"
          class="w-full max-w-xl"
          onerror={() => (loadFailed = true)}
        ></audio>
      {/if}
    {/key}
    {#if loadFailed}
      <p class="text-xs font-medium text-danger">This media file could not be loaded</p>
    {/if}
  {:else if failed}
    <p class="text-xs font-medium text-danger">This media file could not be loaded</p>
  {:else}
    <div class="flex items-center justify-center gap-2 text-[11px] text-dimmed">
      <Loader2 size={13} class="animate-spin" />
      Loading {alt}
    </div>
  {/if}
</div>
