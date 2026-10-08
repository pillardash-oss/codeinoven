<script lang="ts">
  import { Boxes, ChevronRight, Folder, Globe, Layers } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserAppearanceAccent, browserGroupAccent } from './browser-group-appearance'

  /**
   * The two placement submenus every "new tab" menu shares: pick the box, pick
   * the group.
   *
   * They live in one component so the header button, the strip's own new-tab
   * affordance, each group's `+` and a tab's context menu all offer the same box
   * and group lists with the same colours, and a box added anywhere shows up
   * everywhere without a second list being maintained. The caller decides what the
   * choice means: the ambient menu treats it as the whole placement, while a tab's
   * menu inherits the rest from the tab that was clicked.
   */

  interface Props {
    /** The chosen placement. An absent field means "not chosen by this menu", so
     *  the caller can fall back to its own ambient box or group. */
    onCreate: (choice: { boxId?: string | null; groupId?: string | null }) => void
  }

  let { onCreate }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'
  const subContentClass =
    'z-50 max-h-[calc(100dvh-1.5rem)] min-w-44 max-w-[calc(100vw-1.5rem)] overflow-x-hidden overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg'
</script>

<ContextMenu.Sub>
  <ContextMenu.SubTrigger class={itemClass}>
    <Boxes size={13} class="shrink-0 text-muted" />
    New tab in box
    <ChevronRight size={13} class="ml-auto text-muted" />
  </ContextMenu.SubTrigger>
  <ContextMenu.Portal>
    <ContextMenu.SubContent
      avoidCollisions
      collisionPadding={12}
      updatePositionStrategy="always"
      class={subContentClass}
    >
      <ContextMenu.Item class={itemClass} onSelect={() => onCreate({ boxId: null })}>
        <Globe size={13} class="shrink-0 text-muted" />
        No box
      </ContextMenu.Item>
      {#each globalBrowser.boxes as box (box.id)}
        <ContextMenu.Item class={itemClass} onSelect={() => onCreate({ boxId: box.id })}>
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            style="background-color: {browserAppearanceAccent(box)}"
          ></span>
          <span class="truncate">{box.name}</span>
        </ContextMenu.Item>
      {/each}
    </ContextMenu.SubContent>
  </ContextMenu.Portal>
</ContextMenu.Sub>

<ContextMenu.Sub>
  <ContextMenu.SubTrigger class={itemClass}>
    <Folder size={13} class="shrink-0 text-muted" />
    New tab in group
    <ChevronRight size={13} class="ml-auto text-muted" />
  </ContextMenu.SubTrigger>
  <ContextMenu.Portal>
    <ContextMenu.SubContent
      avoidCollisions
      collisionPadding={12}
      updatePositionStrategy="always"
      class={subContentClass}
    >
      <ContextMenu.Item class={itemClass} onSelect={() => onCreate({ groupId: null })}>
        <Layers size={13} class="shrink-0 text-muted" />
        Ungrouped
      </ContextMenu.Item>
      {#each globalBrowser.orderedGroups as group (group.id)}
        <ContextMenu.Item class={itemClass} onSelect={() => onCreate({ groupId: group.id })}>
          <span
            class="h-2 w-2 shrink-0 rounded-full"
            style="background-color: {browserGroupAccent(group)}"
          ></span>
          <span class="truncate">{group.name}</span>
        </ContextMenu.Item>
      {/each}
    </ContextMenu.SubContent>
  </ContextMenu.Portal>
</ContextMenu.Sub>
