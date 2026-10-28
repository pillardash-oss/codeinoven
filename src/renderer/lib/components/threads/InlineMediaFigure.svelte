<script lang="ts">
  import InlineFigure from './InlineFigure.svelte'

  interface Props {
    src: string
    kind: 'audio' | 'video'
    filename: string
    onExpand: () => void
  }

  let { src, kind, filename, onExpand }: Props = $props()
</script>

<!-- A video is content, so it is drawn the way a picture is: no frame, no caption,
     no border, and the player's own controls carry full screen and everything
     else a viewer needs. An audio player has no picture and no such control, so
     it keeps the file's name and the expand affordance beside it. -->
{#if kind === 'video'}
  <figure class="min-w-0 w-full max-w-full self-start">
    <video class="block max-h-96 w-full" {src} controls preload="none" playsinline>
      <track kind="captions" />
    </video>
  </figure>
{:else}
  <InlineFigure {filename} {onExpand}>
    <audio class="w-full" {src} controls preload="none"></audio>
  </InlineFigure>
{/if}
