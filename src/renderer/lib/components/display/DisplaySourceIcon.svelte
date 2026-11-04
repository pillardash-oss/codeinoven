<script lang="ts">
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import type { DisplaySourceKind } from '$shared/ipc/display'
  import CioPhone from '$lib/components/icons/cio/CioPhone.svelte'
  import CioTablet from '$lib/components/icons/cio/CioTablet.svelte'

  /**
   * The mark of one mirror target.
   *
   * A tab, a dock row and a picker card all name the same thing, so the mapping
   * lives here once: a handset for an Android target, a slab for a simulator, the
   * screen for the desktop, and a window for one window of it.
   */
  interface Props {
    kind: DisplaySourceKind | null
    size?: number
    class?: string
  }

  let { kind, size = 15, class: className = '' }: Props = $props()
</script>

{#if kind === 'android'}
  <CioPhone {size} class={className} />
{:else if kind === 'ios'}
  <CioTablet {size} class={className} />
{:else if kind === 'desktop-screen'}
  <CioDisplay {size} class={className} />
{:else if kind === 'desktop-window'}
  <CioWindow {size} class={className} />
{:else}
  <CioDisplay {size} class={className} />
{/if}
