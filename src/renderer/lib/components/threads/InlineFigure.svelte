<script lang="ts">
  import { Expand } from '@lucide/svelte'
  import type { Snippet } from 'svelte'

  /**
   * The chrome every inline figure wears: a 1px frame, an `h-8` caption bar
   * carrying the filename and the expand affordance, and the picture or media
   * body underneath.
   *
   * The same header the artifact and Mermaid cards draw, so a file the agent
   * delivered and a fence it wrote read as one kind of surface in a transcript.
   */
  interface Props {
    /** The file's name, which the caption truncates and the actions name. */
    filename: string
    /** Opens the file fullscreen. */
    onExpand: () => void
    /**
     * How the frame is sized.
     *
     * `hug` gives the frame its content's width, which is what a picture wants:
     * a box wider than the picture is a box that lies about it. `fill` takes the
     * message column, which is what a body with no size of its own needs (audio,
     * and a video whose metadata has not loaded yet).
     */
    fit?: 'hug' | 'fill'
    children: Snippet
  }

  let { filename, onExpand, fit = 'hug', children }: Props = $props()
</script>

<figure
  class={[
    // `self-start` keeps a layout that arranges figures from stretching one to
    // its row: a frame taller than its picture would put the empty space back
    // inside the box this frame exists to avoid.
    'min-w-0 self-start overflow-hidden border bg-surface',
    fit === 'hug' ? 'w-fit max-w-full' : 'w-full'
  ]}
>
  <!-- The caption takes the width the body settles on instead of adding its own
       filename to the frame's width: `w-0 min-w-full` contributes nothing to the
       hug the body decides, so a long name truncates rather than widening the
       frame past the picture. -->
  <figcaption class="flex h-8 w-0 min-w-full items-center justify-between gap-2 border-b px-2">
    <span class="truncate text-[0.6875rem] text-muted" title={filename}>{filename}</span>
    <button
      type="button"
      class="shrink-0 p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      title="Expand {filename}"
      aria-label="Expand {filename}"
      onclick={onExpand}
    >
      <Expand size={13} />
    </button>
  </figcaption>
  {@render children()}
</figure>
