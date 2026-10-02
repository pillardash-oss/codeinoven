<script lang="ts">
  import { Puzzle } from '@lucide/svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { BrowserExtension } from '$shared/ipc-contract'
  import { browserExtensions } from '$lib/stores/browser-extensions.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { GLOBAL_BROWSER_CONTEXT, globalBrowser } from '$lib/stores/global-browser.svelte'

  /**
   * The extensions the user pinned, worn by the header while the browser view is
   * the one on screen, and mounted by no other view.
   *
   * This is what a browser's toolbar is for, without the toolbar: one click opens
   * the extension's own popup. Electron draws no toolbar and no action popup, so
   * the popup opens in the browser's rail instead. A pin is chrome of the browser
   * view, so leaving that view puts the pins away with the rest of its chrome and
   * no other view has to know a pin exists.
   *
   * A pin is only shown while it can act. The extension has to run in the box the
   * browser's tab on screen lives in, because that is the jar its popup opens in
   * and the only place it is loaded; with no browser tab nothing of the extension
   * is running, so the header keeps quiet rather than offering a click that cannot
   * land. Which extensions are pinned, and how many may be, is main's rule; this
   * surface only draws it.
   */

  const tab = $derived(globalBrowser.activeTab)
  /** The jar and tab the pins are drawn for, as the activity store keys them. */
  const jar = $derived(tab?.boxId ?? '')
  const activeTabId = $derived(tab?.id ?? '')
  /** The pins this box can act on, in the order they were installed. */
  const pinned = $derived(tab ? browserExtensions.pinnedExtensionsInJar(tab.boxId ?? '') : [])

  /** The popup this pin is currently displaying, rather than a retained page. */
  function openPopupFor(extensionId: string): string | null {
    if (!tab || !globalBrowser.popupsSidebarShown) return null
    const popupId = browserPopupWindows.extensionPopupFor(extensionId, tab.id)
    return browserPopupWindows.active()?.id === popupId ? popupId : null
  }

  /** What one pin's control says, the same words for the tooltip and for a reader
   *  that only hears the name. */
  function pinLabel(extension: BrowserExtension): string {
    return openPopupFor(extension.id) === null
      ? `Open the ${extension.name} popup`
      : `Hide the ${extension.name} popup`
  }

  /** Chrome's own shape for a long badge: anything past four characters becomes
   *  a plus, so the badge cannot outgrow the icon it sits on. */
  function badgeLabel(text: string): string {
    return text.length > 4 ? `${text.slice(0, 3)}+` : text
  }

  /**
   * The action icons that would not decode, so each is drawn as the extension's
   * manifest icon instead.
   *
   * Main resolves an action icon's bytes before sending it, so a pin normally
   * receives a data URL and this stays empty. It exists because the alternative to
   * one is a broken image glyph where the extension's icon belongs, and an icon
   * that fails to decode must never be what the user sees.
   */
  const undrawableIcons = new SvelteSet<string>()
  let draggingId = $state<string | null>(null)

  function dropPinned(targetId: string): void {
    const sourceId = draggingId
    draggingId = null
    if (!sourceId || sourceId === targetId) return
    const reordered = [...pinned]
    const sourceIndex = reordered.findIndex((extension) => extension.id === sourceId)
    const targetIndex = reordered.findIndex((extension) => extension.id === targetId)
    if (sourceIndex < 0 || targetIndex < 0) return
    const [source] = reordered.splice(sourceIndex, 1)
    if (!source) return
    reordered.splice(targetIndex, 0, source)
    const ids = reordered.map((extension) => extension.id)
    let index = 0
    const orderedIds = browserExtensions.extensions.map((extension) =>
      pinned.some((pin) => pin.id === extension.id) ? (ids[index++] ?? extension.id) : extension.id
    )
    void browserExtensions.reorder(orderedIds)
  }

  /**
   * Open a pinned extension's popup in the rail, or hide the one it already has.
   *
   * The popup is hosted by the rail, which is chrome of this same view, so all the
   * click has to do is make sure that tool is the one showing.
   */
  async function toggle(extensionId: string): Promise<void> {
    const current = tab
    if (!current) return
    const open = openPopupFor(extensionId)
    if (open !== null) {
      browserPopupWindows.dismiss(open)
      return
    }
    const popupId = await browserPopupWindows.openExtension(
      {
        projectId: GLOBAL_BROWSER_CONTEXT.projectId,
        threadId: GLOBAL_BROWSER_CONTEXT.threadId,
        tabId: current.id,
        boxId: current.boxId
      },
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
      {@const activity = browserExtensions.activityFor(jar, activeTabId, extension.id)}
      {@const actionIcon = activity?.iconUrl ?? null}
      {@const icon =
        actionIcon !== null && !undrawableIcons.has(actionIcon)
          ? actionIcon
          : extension.iconDataUrl}
      <button
        type="button"
        draggable
        ondragstart={(event) => {
          draggingId = extension.id
          event.dataTransfer?.setData('text/plain', extension.id)
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
        }}
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => {
          event.preventDefault()
          dropPinned(extension.id)
        }}
        ondragend={() => (draggingId = null)}
        class:opacity-50={draggingId === extension.id}
        class="relative flex h-8 w-8 items-center justify-center transition-colors duration-150 hover:bg-elevated focus-visible:bg-elevated {openPopupFor(
          extension.id
        )
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:text-foreground'}"
        title={activity?.title ?? pinLabel(extension)}
        aria-label={pinLabel(extension)}
        aria-pressed={openPopupFor(extension.id) !== null}
        onclick={() => void toggle(extension.id)}
      >
        {#if icon}
          <img
            src={icon}
            alt=""
            class="h-4 w-4 rounded-sm object-contain"
            onerror={() => actionIcon !== null && undrawableIcons.add(actionIcon)}
          />
        {:else}
          <Puzzle size={15} />
        {/if}
        {#if activity?.badgeText}
          <!-- The extension's own badge, in its own colour: the one part of a
               toolbar this browser does not draw, drawn on the pin instead. -->
          <span
            class="pointer-events-none absolute -right-0.5 -bottom-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-0.5 text-[0.625rem] leading-none font-medium text-white"
            style="background-color: {activity.badgeColor ?? '#d93025'}"
          >
            {badgeLabel(activity.badgeText)}
          </span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
