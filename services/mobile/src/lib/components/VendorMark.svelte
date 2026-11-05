<script lang="ts">
  import { getModelVendorIconSvg } from '#shared/vendor-icons/registry'

  /**
   * The vendor's own mark, as the desktop renders it beside a model or a
   * harness. The artwork is bundled from the same registry the workstation uses,
   * so a provider reads the same on both clients. A phone holds a model id rather
   * than the provider that bills it, so the id's own prefix finds the mark; a
   * name with no bundled artwork draws nothing rather than a made-up logo.
   */
  interface Props {
    /** The provider or harness name, as the thread stores it. */
    name: string | null
    /** Pixels; the mark is square. */
    size?: number
  }

  let { name, size = 12 }: Props = $props()

  let svg = $derived(name ? getModelVendorIconSvg(name) : undefined)
</script>

{#if svg}
  <span class="vendor-mark" style:width={`${size}px`} style:height={`${size}px`} aria-hidden="true">
    {@html svg}
  </span>
{/if}

<style>
  /* The bundled artwork is monochrome and follows the text around it. */
  .vendor-mark {
    flex: none;
    display: inline-grid;
    place-items: center;
  }

  .vendor-mark :global(svg) {
    width: 100%;
    height: 100%;
    display: block;
  }
</style>
