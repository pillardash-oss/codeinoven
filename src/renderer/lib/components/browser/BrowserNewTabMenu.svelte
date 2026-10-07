<script lang="ts">
  import type { Snippet } from 'svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { openBrowserNewTabMenu } from './browser-chrome-menus'

  /**
   * The menu behind every "new tab" affordance outside a tab's own row.
   *
   * A left click on the trigger stays the one-click new tab; a right click opens
   * this menu, which is the one place a user says where the tab goes: a box, a
   * group, or beside the tab on screen. The trigger is a snippet because the three
   * call sites are a header icon, the empty strip's button and a group's `+`, and
   * they keep their own look while sharing this one list.
   */

  interface Props {
    /** The group a plain new tab joins, and the fallback when the box submenu is
     *  chosen without naming a group (a group's `+` should stay inside it). */
    groupId?: string | null
    /** The box a plain new tab runs in, and the fallback for the placement menu. */
    boxId?: string | null
    /** When set, the menu offers new tab before/after this tab. */
    anchorTabId?: string | null
    trigger: Snippet
  }

  let { groupId, boxId, anchorTabId = null, trigger }: Props = $props()

  async function openMenu(event: MouseEvent): Promise<void> {
    event.preventDefault()
    const anchorId = anchorTabId
    const active = globalBrowser.activeTab
    const targetGroupId = groupId === undefined ? (active?.groupId ?? null) : groupId
    const targetBoxId = boxId === undefined ? (active?.boxId ?? null) : boxId
    const choice = await openBrowserNewTabMenu(
      {
        groupId: targetGroupId,
        boxId: targetBoxId,
        anchored: anchorId !== null,
        groups: globalBrowser.orderedGroups.map(({ id, name }) => ({ id, name })),
        boxes: globalBrowser.boxes.map(({ id, name }) => ({ id, name }))
      },
      event.clientX,
      event.clientY
    )
    if (!choice) return
    if (choice.action === 'new') {
      globalBrowser.openNewTabAddress(choice.groupId, choice.boxId)
    } else if (anchorId && globalBrowser.tabById(anchorId)) {
      globalBrowser.createTab('', targetGroupId, targetBoxId, {
        tabId: anchorId,
        position: choice.action
      })
      globalBrowser.openAddressSpotlight()
    }
  }
</script>

<div class="contents" role="presentation" oncontextmenu={(event) => void openMenu(event)}>
  {@render trigger()}
</div>
