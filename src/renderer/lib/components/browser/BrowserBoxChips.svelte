<script lang="ts">
  import {
    boxIdForJar,
    DEFAULT_BOX_ID,
    type GlobalBrowserBox
  } from '$lib/stores/global-browser-types'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserAppearanceAccent } from './browser-group-appearance'

  interface Props {
    /** The jars the extension runs in, exactly as the record spells them: box ids,
     *  with the empty string for the context's own jar. */
    jars: readonly string[]
  }

  let { jars }: Props = $props()

  /** How many names fit before the row has to give way to a count. A row already
   *  carries a switch and a settings button, so the chips are the part that yields. */
  const MAX_CHIPS = 3

  /**
   * The boxes worth naming on the row.
   *
   * The default box contributes nothing. It is where the browser's own pages live,
   * so naming it would put a chip on almost every unboxed extension and say nothing
   * about any of them; the boxes a user made are the ones that distinguish a row.
   * A jar whose box is gone is dropped rather than drawn as a missing name.
   */
  const boxes = $derived(
    jars
      .map((jar) => globalBrowser.boxById(boxIdForJar(jar)))
      .filter((box): box is GlobalBrowserBox => box !== null && box.id !== DEFAULT_BOX_ID)
  )
  const hidden = $derived(Math.max(0, boxes.length - MAX_CHIPS))
  const label = $derived(boxes.map((box) => box.name).join(', '))
</script>

{#if boxes.length > 0}
  <span class="flex min-w-0 shrink-0 items-center gap-1" title={`Runs in ${label}`}>
    {#each boxes.slice(0, MAX_CHIPS) as box (box.id)}
      <span
        class="max-w-20 truncate rounded-md px-1.5 py-0.5 font-mono text-[0.625rem] text-foreground"
        style:background-color={`color-mix(in srgb, ${browserAppearanceAccent(box)} 16%, var(--color-raised))`}
      >
        {box.name}
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
