<script lang="ts">
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import AudioPlayer from '../ui/AudioPlayer.svelte'

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

  let player = $state<HTMLVideoElement | null>(null)

  /**
   * Hand the video to the app's viewer instead of the browser's own fullscreen.
   *
   * A video is the one media element with a fullscreen control of its own, and
   * that control enters element fullscreen over the app: it draws no viewer, no
   * filename and no annotations, and it is what the reader meets when they ask
   * for the big view. The inline player therefore hides that control
   * (`nofullscreen`) and answers the same request here, opening the app's own
   * fullscreen surface on the frame the video was at.
   */
  function expandFromPlayer(): void {
    onExpand(player?.currentTime ?? 0)
  }
</script>

<!-- Media is content, so it is drawn the way a picture is: no frame, no caption,
     no border. A video keeps a hover tool for the fullscreen view because its own
     player control for it is hidden, and it answers a double click as well, which
     is the gesture a video player normally uses for the same thing. Audio is
     played by the app's own player, which carries the same tool on hover. -->
{#if kind === 'video'}
  <figure class="group/md-video relative min-w-0 w-full max-w-full self-start">
    <video
      bind:this={player}
      class="block max-h-96 w-full"
      {src}
      controls
      controlslist="nofullscreen"
      preload="none"
      playsinline
      ondblclick={(event: MouseEvent) => {
        event.preventDefault()
        expandFromPlayer()
      }}
    >
      <track kind="captions" />
    </video>
    <div class="pointer-events-none absolute top-1 right-1 z-20 h-0">
      <button
        type="button"
        class="pointer-events-none flex size-6 items-center justify-center border border-border bg-surface text-dimmed opacity-0 shadow-lg transition-opacity duration-150 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/md-video:pointer-events-auto group-hover/md-video:opacity-100"
        aria-label="Open {filename} full screen"
        title="Open {filename} full screen"
        onclick={expandFromPlayer}
      >
        <CioMaximize size={13} />
      </button>
    </div>
  </figure>
{:else}
  <AudioPlayer {src} label={filename} onExpand={() => onExpand()} />
{/if}
