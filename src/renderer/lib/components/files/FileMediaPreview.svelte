<script lang="ts">
  import { loadCachedPanelModule } from '$lib/lazy-panel'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'

  interface Props {
    src: string | null
    alt: string
    kind: 'video' | 'audio'
    failed?: boolean
  }

  let { src, alt, kind, failed = false }: Props = $props()
</script>

<div class="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
  {#if src}
    {#key src}
      <!-- The app's own players, not the platform's media bar: a file preview is
           the same surface as a conversation's media, so it plays the same way,
           down to the failure it reports. -->
      {#if kind === 'video'}
        {#await loadCachedPanelModule('module:lib/components/ui/VideoPlayer.svelte', () => import('../ui/VideoPlayer.svelte')) then { default: VideoPlayer }}
          <VideoPlayer {src} label={alt} fit="fill" class="max-h-full max-w-full" />
        {/await}
      {:else}
        {#await loadCachedPanelModule('module:lib/components/ui/AudioPlayer.svelte', () => import('../ui/AudioPlayer.svelte')) then { default: AudioPlayer }}
          <AudioPlayer {src} label={alt} class="w-full max-w-xl" />
        {/await}
      {/if}
    {/key}
  {:else if failed}
    <p class="text-xs font-medium text-danger">This media file could not be loaded</p>
  {:else}
    <div class="flex items-center justify-center gap-2 text-[0.6875rem] text-dimmed">
      <CioSpinner size={13} class="animate-spin" />
      Loading {alt}
    </div>
  {/if}
</div>
