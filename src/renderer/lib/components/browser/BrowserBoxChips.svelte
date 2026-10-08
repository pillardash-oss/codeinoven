<script lang="ts">
  import { boxIdForJar, type GlobalBrowserBox } from '$lib/stores/global-browser-types'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserAppearanceAccent, browserAppearanceIconUrl } from './browser-group-appearance'

  interface Props {
    /** The jars the extension runs in, exactly as the record spells them: box ids,
     *  with the empty string for the context's own jar. */
    jars: readonly string[]
  }

  let { jars }: Props = $props()

  /** How many marks fit before the row has to give way to a count. A row already
   *  carries a switch and a settings button, so the marks are the part that
   *  yields. */
  const MAX_CHIPS = 3

  /**
   * The boxes worth marking on the row.
   *
   * Every box the extension runs in is drawn, the default box included: a row that
   * hid one of them would show fewer marks than the boxes the user turned on,
   * which reads as an extension that is not loaded where it is. A jar whose box is
   * gone is dropped rather than drawn as a missing mark.
   */
  const boxes = $derived(
    jars
      .map((jar) => globalBrowser.boxById(boxIdForJar(jar)))
      .filter((box): box is GlobalBrowserBox => box !== null)
  )
  const hidden = $derived(Math.max(0, boxes.length - MAX_CHIPS))
  const label = $derived(boxes.map((box) => box.name).join(', '))

  /** A box's own mark: its picked icon, or a dot in its accent colour, resolved
   *  the way every other box and group in the browser resolves one. */
  function iconUrl(box: GlobalBrowserBox): string | null {
    return browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
  }
</script>

{#if boxes.length > 0}
  <span class="flex min-w-0 shrink-0 items-center gap-0.5" title={`Runs in ${label}`}>
    {#each boxes.slice(0, MAX_CHIPS) as box (box.id)}
      {@const url = iconUrl(box)}
      <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm" title={box.name}>
        {#if url}
          <img src={url} alt="" class="h-4 w-4 rounded-sm object-contain" />
        {:else}
          <span class="h-2 w-2 rounded-full" style:background-color={browserAppearanceAccent(box)}
          ></span>
        {/if}
      </span>
    {/each}
    {#if hidden > 0}
      <span
        class="shrink-0 text-[0.625rem] text-dimmed"
        title={`${hidden} more: ${boxes
          .slice(MAX_CHIPS)
          .map((box) => box.name)
          .join(', ')}`}
      >
        +{hidden}
      </span>
    {/if}
  </span>
{/if}
