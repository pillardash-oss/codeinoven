<script lang="ts">
  import { Boxes, ChevronDown } from '@lucide/svelte'
  import { loadBrowser } from '$lib/stores/browser-access.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { DEFAULT_BOX_ID } from '$lib/stores/global-browser-types'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { openBrowserBoxMenu } from './browser-chrome-menus'
  import {
    browserAppearanceAccent,
    browserAppearanceHasIcon,
    browserAppearanceIconUrl
  } from './browser-group-appearance'

  /**
   * The thread browser's box control.
   *
   * A box is a named cookie jar, so this is where a conversation says whose
   * sign-ins its pages run against. Every conversation starts in its own scope's
   * jar   a project's box, a routine's box, a chat's box   and the control names
   * that as the default. Picking one of the profile's boxes runs this
   * conversation's pages in that box's jar instead, which is how a run can face a
   * site as a different identity than the scope's own.
   *
   * The menu is an OS-native popup, like the downloads and site menus beside it:
   * the page underneath is a `WebContentsView` that composites above the
   * renderer, so a document menu opened under the toolbar would be drawn behind
   * it and never seen.
   *
   * The choice is a reopen rather than a move: a tab cannot change jars in place,
   * so the tab on screen is replaced by an equivalent one in the chosen box and
   * later tabs follow it. The store owns which box that is, so this component
   * only renders the current answer and reports the pick.
   */

  interface Props {
    projectId: string
    threadId: string
    /** The box the tab on screen runs in, or null for the scope's own jar. */
    boxId: string | null
    /** Name the current box beside the icon, which the full screen toolbar has room for. */
    labelled?: boolean
    onChange: (boxId: string | null) => void
  }

  let { projectId, threadId, boxId, labelled = false, onChange }: Props = $props()

  const scopeLabel = $derived(contextSidebarState.browserScopeBoxLabel(projectId, threadId))
  const current = $derived(boxId ? globalBrowser.boxById(boxId) : null)
  const currentName = $derived(current?.name ?? scopeLabel)
  const currentAccent = $derived(current ? browserAppearanceAccent(current) : null)
  /**
   * The chosen box's own icon, worn in place of the generic box glyph so the
   * trigger shows which jar is in use at a glance. Null for the scope's own jar
   * (which has no appearance to draw) and for a box that was only given a colour,
   * which falls back to an accent dot exactly like the tab row's box badge.
   */
  const currentIcon = $derived(
    current && browserAppearanceHasIcon(current)
      ? browserAppearanceIconUrl(current, globalBrowser.boxIconUrl(current.id))
      : null
  )

  /** Whether the native menu is on screen, for the trigger's expanded state. */
  let menuOpen = $state(false)

  /**
   * The boxes the menu offers, read at the click rather than derived up front.
   *
   * The list belongs to the global browser's store, so it is asked for through the
   * access seam: that is what wires the store and waits for the stored tab list
   * even when this button is the first thing in the window to reach for the
   * browser. A thread browser with no boxes on offer would look broken rather than
   * empty.
   *
   * The profile's default box is left out: its jar is the global browser's own
   * context, which a thread browser tab cannot join, and `jarIdForBox` reads its
   * id as the scope's own jar   the menu's first entry already. Offering it would
   * put two rows on the menu that mean the same jar.
   */
  async function menuBoxes(): Promise<{ id: string; name: string }[]> {
    const browser = await loadBrowser()
    return browser.boxes
      .filter((box) => box.id !== DEFAULT_BOX_ID)
      .map((box) => ({ id: box.id, name: box.name }))
  }

  async function openMenu(anchor: HTMLElement): Promise<void> {
    const boxes = await menuBoxes()
    menuOpen = true
    // The call answers when the popup closes, so the trigger's expanded state
    // lasts exactly as long as the menu does. It never rejects, which is why the
    // clear can sit between the answer and the pick without a try.
    const choice = await openBrowserBoxMenu({ scopeLabel, boxes, currentBoxId: boxId }, anchor)
    menuOpen = false
    if (!choice || choice.boxId === boxId) return
    onChange(choice.boxId)
  }
</script>

<button
  type="button"
  class={[
    'relative flex h-7 shrink-0 items-center justify-center rounded-md transition-colors',
    labelled ? 'gap-1.5 px-2 text-[0.6875rem] font-medium' : 'w-7',
    menuOpen ? 'bg-elevated text-foreground' : 'text-dimmed hover:bg-elevated hover:text-foreground'
  ]}
  aria-label={`Box: ${currentName}. Choose which box this tab and new tabs use`}
  aria-expanded={menuOpen}
  aria-haspopup="menu"
  title={`Box: ${currentName}`}
  onclick={(event) => void openMenu(event.currentTarget)}
>
  {#if current && currentIcon}
    <img src={currentIcon} alt="" class="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
  {:else if current}
    <span class="h-2.5 w-2.5 shrink-0 rounded-full" style="background-color: {currentAccent}"
    ></span>
  {:else}
    <Boxes size={13} />
  {/if}
  {#if labelled}
    <span class="max-w-32 truncate">{currentName}</span>
    <ChevronDown size={12} />
  {/if}
</button>
