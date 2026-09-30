<script lang="ts">
  import { Puzzle } from '@lucide/svelte'
  import { GLOBAL_BROWSER_PROJECT_ID, type BrowserExtension } from '$shared/ipc-contract'
  import { browserExtensions } from '$lib/stores/browser-extensions.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  /**
   * The extensions the user pinned, worn by the app header for the box on screen.
   *
   * This is what a browser's toolbar is for, without the toolbar: one click opens
   * the extension's own popup from anywhere in the app. Electron draws no toolbar
   * and no action popup, so the popup opens in the browser's rail instead, and the
   * header is what keeps it one click away from every view.
   *
   * A pin is only shown while it can act. The extension has to run in the box the
   * browser's tab on screen lives in, because that is the jar its popup opens in
   * and the only place it is loaded; with no browser tab nothing of the extension
   * is running, so the header keeps quiet rather than offering a click that cannot
   * land. Which extensions are pinned, and how many may be, is main's rule; this
   * surface only draws it.
   */

  const tab = $derived(globalBrowser.activeTab)
  /** The pins this box can act on, in the order they were installed. */
  const pinned = $derived(tab ? browserExtensions.pinnedExtensionsInJar(tab.boxId ?? '') : [])

  /** The popup one pinned extension already has open, or null when it has none. */
  function openPopupFor(extensionId: string): string | null {
    if (!tab) return null
    return browserPopupWindows.extensionPopupFor(extensionId, tab.id)
  }

  /** What one pin's control says, the same words for the tooltip and for a reader
   *  that only hears the name. */
  function pinLabel(extension: BrowserExtension): string {
    return openPopupFor(extension.id) === null
      ? `Open the ${extension.name} popup`
      : `Close the ${extension.name} popup`
  }

  /**
   * Open a pinned extension's popup in the rail, or close the one it already has.
   *
   * The popup is hosted by the rail, and the rail belongs to the browser view, so
   * the click reveals the browser first and opens the popup inside it rather than
   * opening something the user cannot see.
   */
  async function toggle(extensionId: string): Promise<void> {
    const current = tab
    if (!current) return
    const open = browserPopupWindows.extensionPopupFor(extensionId, current.id)
    if (open !== null) {
      browserPopupWindows.close(open)
      return
    }
    workspaceState.navigateToBrowser?.()
    const popupId = await browserPopupWindows.openExtension(
      GLOBAL_BROWSER_PROJECT_ID,
      current.id,
      extensionId
    )
    if (popupId !== null) globalBrowser.showPopupsSidebar()
  }
</script>

{#if pinned.length > 0}
  <!-- No wrapper chrome and no count: a pin is a page's icon, and the header's own
       spacing is what keeps the row reading as part of it. -->
  <div class="flex items-center gap-1">
    {#each pinned as extension (extension.id)}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center transition-colors duration-150 hover:bg-elevated focus-visible:bg-elevated {openPopupFor(
          extension.id
        )
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:text-foreground'}"
        title={pinLabel(extension)}
        aria-label={pinLabel(extension)}
        aria-pressed={openPopupFor(extension.id) !== null}
        onclick={() => void toggle(extension.id)}
      >
        {#if extension.iconDataUrl}
          <img src={extension.iconDataUrl} alt="" class="h-4 w-4 rounded-sm object-contain" />
        {:else}
          <Puzzle size={15} />
        {/if}
      </button>
    {/each}
  </div>
{/if}
