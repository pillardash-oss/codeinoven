<script lang="ts">
  import AssistantIcon from './AssistantIcon.svelte'
  import { customSvgDataUrl } from '#lib/marks'
  import type { Assistant } from '#lib/api/types'

  /**
   * An assistant's mark. An assistant always has one: its own stored SVG when it
   * has one, and the app's plush assistant mark otherwise. Its name is often a
   * whole sentence, so the name is never drawn where a mark is expected.
   */
  interface Props {
    assistant: Pick<Assistant, 'customSvg' | 'color'>
    size?: number
  }

  let { assistant, size = 36 }: Props = $props()

  /** The muted tint an assistant without an accent colour keeps. */
  const FALLBACK_COLOR = '#8b95a5'

  let color = $derived(assistant.color ?? FALLBACK_COLOR)
  let svg = $derived(assistant.customSvg ? customSvgDataUrl(assistant.customSvg, color) : null)
</script>

<span
  class="mark"
  style:width="{size}px"
  style:height="{size}px"
  style:--tint={color}
  aria-hidden="true"
>
  {#if svg}
    <img src={svg} alt="" width={size} height={size} />
  {:else}
    <AssistantIcon size={Math.round(size * 0.66)} />
  {/if}
</span>
