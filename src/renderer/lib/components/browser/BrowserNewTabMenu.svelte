<script lang="ts">
  import { ArrowDown, ArrowUp, Plus } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import BrowserTabPlacementItems from './BrowserTabPlacementItems.svelte'

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

  let { groupId = null, boxId = null, anchorTabId = null, trigger }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'

  function openHere(): void {
    globalBrowser.openNewTabAddress(groupId, boxId)
  }

  /** Open a blank tab beside another and take the caret, which is what "new tab
   *  before/after this one" is. */
  function createNear(position: 'before' | 'after'): void {
    if (!anchorTabId) return
    globalBrowser.createTab('', groupId, boxId, { tabId: anchorTabId, position })
    globalBrowser.openAddressSpotlight()
  }

  function createPlaced(choice: { boxId?: string | null; groupId?: string | null }): void {
    globalBrowser.openNewTabAddress(choice.groupId ?? groupId, choice.boxId ?? boxId)
  }
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="contents">
    {@render trigger()}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      avoidCollisions
      collisionPadding={12}
      updatePositionStrategy="always"
      class="z-50 max-h-[calc(100vh-1.5rem)] min-w-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      <ContextMenu.Item class={itemClass} onSelect={openHere}>
        <Plus size={13} class="shrink-0 text-muted" />
        New tab
      </ContextMenu.Item>
      <ContextMenu.Separator class="my-1 h-px bg-border" />
      <BrowserTabPlacementItems onCreate={createPlaced} />
      {#if anchorTabId}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item class={itemClass} onSelect={() => createNear('before')}>
          <ArrowUp size={13} class="shrink-0 text-muted" />
          New tab before this tab
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={() => createNear('after')}>
          <ArrowDown size={13} class="shrink-0 text-muted" />
          New tab after this tab
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
