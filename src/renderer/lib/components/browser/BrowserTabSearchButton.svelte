<script lang="ts">
  import { Search } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'

  /**
   * The browser view's tab-search action.
   *
   * The browser view registers it with `viewActions`, so it renders beside the
   * view switcher with every other view's quick actions instead of in a cluster
   * of its own. The button toggles the reveal flag; the field it reveals lives
   * in the tab strip, which is where the search actually filters.
   */

  const open = $derived(globalBrowser.tabSearchOpen)
</script>

<button
  type="button"
  class="flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 {open
    ? 'bg-elevated text-foreground'
    : 'text-muted hover:bg-elevated hover:text-foreground'}"
  aria-label={open ? 'Close tab search' : 'Search browser tabs'}
  title={open ? 'Close tab search' : 'Search tabs'}
  aria-pressed={open}
  onclick={() => globalBrowser.toggleTabSearch()}
>
  <Search size={15} strokeWidth={1.8} />
</button>
