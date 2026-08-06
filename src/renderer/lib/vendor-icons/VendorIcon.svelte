<script lang="ts">
  import { getVendorIconSvg } from './registry'

  interface Props {
    /** Vendor display name (e.g. "OpenAI", "Mistral AI"). */
    name: string
    /** Square icon edge in pixels. */
    size?: number
    class?: string
  }

  let { name, size = 14, class: className = '' }: Props = $props()
  let svg = $derived(getVendorIconSvg(name))
  let monogram = $derived(name.trim().charAt(0).toUpperCase() || '?')
</script>

<!--
  The SVG markup is bundled at build time from vetted package assets
  (see registry.ts) — never user or network supplied, so {@html} is safe.
  Icons size via `1em`, hence font-size drives the box; mono marks use
  currentColor and inherit the surrounding text color.
-->
<span
  class={`inline-flex shrink-0 items-center justify-center ${className}`}
  style:width={`${size}px`}
  style:height={`${size}px`}
  style:font-size={`${size}px`}
  aria-hidden="true"
>
  {#if svg}
    <!-- eslint-disable-next-line svelte/no-at-html-tags -- vendor icons are trusted bundled SVGs -->
    {@html svg}
  {:else}
    <span
      class="flex h-full w-full items-center justify-center rounded-[3px] bg-elevated font-semibold text-dimmed"
      style:font-size={`${Math.round(size * 0.6)}px`}
    >
      {monogram}
    </span>
  {/if}
</span>
