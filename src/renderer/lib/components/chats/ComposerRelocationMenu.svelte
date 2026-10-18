<script lang="ts">
  import CioCopy from '@codeinoven/icons/CioCopy.svelte'
  import CioForward from '@codeinoven/icons/CioForward.svelte'
  import { ContextMenu } from 'bits-ui'

  import type { Snippet } from 'svelte'

  interface Props {
    /**
     * The noun the item is named by (`media attachment`, `doc comment`,
     * `inspector comment`), or null on a surface that offers no relocation:
     * a chat, an assistant task or a browser conversation has no project to
     * relocate into, so its chips stay plain.
     */
    noun: string | null
    /** The item's own name, shown as the menu's header so the target is never ambiguous. */
    name: string
    /**
     * Reports the menu opening and closing. A chip that lives inside a hover
     * popover passes this so the popover stays open while the menu is up.
     */
    onOpenChange?: (open: boolean) => void
    /** Carry the item to another chat, taking it out of this one. */
    onRelocate: () => void
    /** Carry a copy to another chat, leaving this one untouched. */
    onCopy: () => void
    children: Snippet
  }

  let { noun, name, onOpenChange, onRelocate, onCopy, children }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated'
</script>

{#if noun}
  <ContextMenu.Root
    onOpenChange={(open) => {
      onOpenChange?.(open)
    }}
  >
    <ContextMenu.Trigger class="contents">
      {@render children()}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content
        avoidCollisions
        collisionPadding={12}
        class="z-50 max-h-[calc(100vh-1.5rem)] min-w-52 overflow-y-auto border border-border bg-surface p-1 shadow-lg"
      >
        <div
          class="truncate px-2.5 pt-1 pb-1.5 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
          title={name}
        >
          {name}
        </div>
        <ContextMenu.Item class={itemClass} onSelect={onRelocate}>
          <CioForward size={13} class="text-muted" />
          Relocate {noun}
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={onCopy}>
          <CioCopy size={13} class="text-muted" />
          Copy {noun}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>
{:else}
  {@render children()}
{/if}
