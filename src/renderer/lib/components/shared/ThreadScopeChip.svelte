<script lang="ts">
  import CioPin from '@pdslng/cio-icon/CioPin.svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { abbreviatedScopeName, threadScopeBucket } from '$lib/threads/thread-scope'
  import type { Thread } from '$shared/types'

  /**
   * The scope a thread belongs to, worn on the row that lists it.
   *
   * The sidebar's thread row and the sidebar's search result row both draw it, so
   * it lives here once: a search result must never state a different scope than
   * the same thread states in the list it came from.
   *
   * The project-rooted Default scope draws nothing at all. It is the absence of a
   * scope, so a chip for it would put a badge on nearly every row and say nothing.
   */
  interface Props {
    thread: Thread
    /** Placement classes from the host row. The chip's own look stays here. */
    classes?: string
  }

  let { thread, classes = '' }: Props = $props()

  let bucket = $derived(threadScopeBucket(thread))
  let color = $derived(bucket ? (bucket.color ?? pickColorForSeed(bucket.id)) : '')
  let iconUrl = $derived.by((): string | null => {
    if (!bucket) return null
    if (bucket.iconType) return getIconSvgDataUrl(bucket.iconType, color)
    if (bucket.color) return generateInitialsIconSvg(bucket.name, color)
    return null
  })
</script>

{#if bucket}
  <!-- The chip is allowed to shrink: its track is the flexible one, so a crowded
       footer narrows the scope (name truncates with an ellipsis) rather than
       letting the chip run under the neighbouring marks. -->
  <span
    class="relative flex min-w-0 max-w-full items-center gap-1 overflow-hidden border-b px-1 text-[0.5625rem] text-muted {classes}"
    title={bucket.name}
    style="border-bottom-color: color-mix(in srgb, {color} 30%, var(--color-muted));"
  >
    {#if iconUrl}
      <img
        src={iconUrl}
        alt=""
        class="h-2 w-2 shrink-0 object-contain opacity-50 grayscale"
        draggable="false"
      />
    {/if}
    {#if bucket.pinned}
      <CioPin size={8} class="shrink-0 text-accent" aria-hidden="true" />
    {/if}
    <!-- The scope is shortened at its own punctuation before the chip ever
         truncates, so a long name keeps its distinguishing head instead of
         spending the chip's width on a prefix several scopes share. The full
         name stays in the title. -->
    <span class="min-w-0 truncate">{abbreviatedScopeName(bucket.name)}</span>
  </span>
{/if}
