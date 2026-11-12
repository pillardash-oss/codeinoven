<script lang="ts">
  import { loadCachedPanelModule } from '$lib/lazy-panel'
  interface Props {
    src: string
    kind: 'audio' | 'video'
    filename: string
    /**
     * Opens the file in the app's fullscreen media surface, at the position the
     * inline player had reached and in the state it was in, so the reader keeps
     * their place and the recording carries on rather than restarting.
     */
    onExpand: (startAt?: number, playing?: boolean) => void
  }

  let { src, kind, filename, onExpand }: Props = $props()
</script>

<!-- Media is content, so it is drawn the way a picture is: no frame, no caption,
     no border. Both players are the app's own, so their controls read as part of
     the application rather than as a platform widget dropped into a message, and
     a source that fails says so instead of leaving a dead control bar. -->
<!-- The players are fetched only when a message actually carries media: a
     conversation without a recording never needed the transport controls, and
     both chunks stay out of the first screen's eager closure. -->
{#if kind === 'video'}
  {#await loadCachedPanelModule('module:lib/components/ui/VideoPlayer.svelte', () => import('../ui/VideoPlayer.svelte')) then { default: VideoPlayer }}
    <VideoPlayer {src} label={filename} onExpand={(at, playing) => onExpand(at, playing)} />
  {/await}
{:else}
  {#await loadCachedPanelModule('module:lib/components/ui/AudioPlayer.svelte', () => import('../ui/AudioPlayer.svelte')) then { default: AudioPlayer }}
    <AudioPlayer {src} label={filename} onExpand={() => onExpand()} />
  {/await}
{/if}
