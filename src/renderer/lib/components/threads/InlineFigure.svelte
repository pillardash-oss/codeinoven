<script lang="ts">
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import type { Snippet } from 'svelte'

  /**
   * The chrome an inline media figure wears when it has no body of its own: a
   * 1px frame, an `h-8` caption bar carrying the filename and the expand
   * affordance, and the player underneath.
   *
   * A picture and a video are drawn without it: they are the content, and their
   * own surface (and, for a video, its player) is the whole affordance. An audio
   * player is a strip with no identity, so it keeps the name beside it.
   */
  interface Props {
    /** The file's name, which the caption truncates and the actions name. */
    filename: string
    /** Opens the file fullscreen. */
    onExpand: () => void
    children: Snippet
  }

  let { filename, onExpand, children }: Props = $props()
</script>

<!-- `self-start` and `w-full` keep the frame inside the message column and out of
     the row stretch a flex layout would apply to it. -->
<figure class="min-w-0 w-full max-w-full self-start overflow-hidden border bg-surface">
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
      <CioMaximize size={13} />
    </button>
  </figcaption>
  {@render children()}
</figure>
