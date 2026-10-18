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

<!-- Both bodies fill the column: a player has no size of its own before its media
     loads, and a frame that hugged one would jump the moment it did. A video
     therefore keeps a standard box and letterboxes inside it, which is how every
     player in the app shows one. -->
<InlineFigure {filename} {onExpand} fit="fill">
  {#if kind === 'video'}
    <video class="max-h-96 w-full" {src} controls preload="none" playsinline>
      <track kind="captions" />
    </video>
  {:else}
    <audio class="w-full" {src} controls preload="none"></audio>
  {/if}
</InlineFigure>
