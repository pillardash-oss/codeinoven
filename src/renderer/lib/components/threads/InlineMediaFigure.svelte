<script lang="ts">
  import AudioPlayer from '../ui/AudioPlayer.svelte'
  import VideoPlayer from '../ui/VideoPlayer.svelte'

  interface Props {
    src: string
    kind: 'audio' | 'video'
    filename: string
    /**
     * Opens the file in the app's fullscreen media surface, at the position the
     * inline player had reached, so the reader keeps their place.
     */
    onExpand: (startAt?: number) => void
  }

  let { src, kind, filename, onExpand }: Props = $props()
</script>

<!-- Media is content, so it is drawn the way a picture is: no frame, no caption,
     no border. Both players are the app's own, so their controls read as part of
     the application rather than as a platform widget dropped into a message, and
     a source that fails says so instead of leaving a dead control bar. -->
{#if kind === 'video'}
  <VideoPlayer {src} label={filename} onExpand={(at) => onExpand(at)} />
{:else}
  <AudioPlayer {src} label={filename} onExpand={() => onExpand()} />
{/if}
