<script lang="ts">
  import { Plus } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import BrowserNewTabMenu from './BrowserNewTabMenu.svelte'

  /**
   * The browser view's new-tab action.
   *
   * The browser view registers it with `viewActions`, so it renders beside the
   * view switcher with every other view's quick actions. A left click is the
   * one-click new tab; a right click opens the placement menu, which is where a
   * tab is put in a box, put in a group, or opened beside the tab on screen. It is
   * a component rather than the plain icon action because only a component can
   * carry the menu, and it paints its own shortcut hint from the keymap so the
   * tooltip reads exactly as the icon action's did.
   */

  const activeTab = $derived(globalBrowser.activeTab)
</script>

<BrowserNewTabMenu
  groupId={activeTab?.groupId ?? null}
  boxId={activeTab?.boxId ?? null}
  anchorTabId={activeTab?.id ?? null}
>
  {#snippet trigger()}
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-elevated hover:text-foreground"
      aria-label="New browser tab"
      title="New tab"
      data-shortcut={keymapState.keysFor('browser-new-tab').join(',')}
      onclick={() => globalBrowser.openNewTabAddress()}
    >
      <Plus size={15} strokeWidth={1.8} />
    </button>
  {/snippet}
</BrowserNewTabMenu>
