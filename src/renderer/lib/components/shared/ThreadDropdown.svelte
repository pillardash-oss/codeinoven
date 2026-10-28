<script lang="ts">
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioEllipsisVertical from '@pdslng/cio-icon/CioEllipsisVertical.svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Component } from 'svelte'

  export interface MenuItem {
    label: string
    icon?: Component
    onClick?: () => void
    danger?: boolean
    divider?: boolean
    disabled?: boolean
    /** When true, ActionSheet renders a check so the item reads as the current selection. */
    selected?: boolean
    /** When true the entry is a non-interactive caption rather than an action.
     *
     *  A menu uses it to name what it acts on before listing the actions, so the
     *  caller does not have to repeat that fact in every entry. The Oven harness
     *  menu leads with the installed version for exactly that reason. `onClick`
     *  is ignored, and the entry stays out of the menu's keyboard navigation. */
    header?: boolean
  }

  interface Props {
    items: MenuItem[]
    title?: string
    ariaLabel?: string
    onOpen?: () => void
    /** Fired when the menu closes   lets a touch reveal undo itself. */
    onClose?: () => void
    open?: boolean
    /** Use a vertical ellipsis for multi-row thread rows; horizontal otherwise. */
    vertical?: boolean
    /**
     * Draw no trigger of its own. The caller owns the control that opens this
     * menu (a project icon opening two menus, say) and opens it through `open`;
     * the trigger stays in the layout as an invisible anchor so the menu still
     * opens beside the control that asked for it.
     */
    anchorOnly?: boolean
  }

  let {
    items,
    title = 'Thread actions',
    ariaLabel = 'Thread actions',
    onOpen = () => undefined,
    onClose = () => undefined,
    open = $bindable(false),
    vertical = false,
    anchorOnly = false
  }: Props = $props()
</script>

<DropdownMenu.Root
  bind:open
  onOpenChange={(o) => {
    if (o) onOpen()
    else onClose()
  }}
>
  <DropdownMenu.Trigger
    class={anchorOnly
      ? 'pointer-events-none absolute inset-0 h-full w-full opacity-0'
      : 'flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground'}
    aria-label={anchorOnly ? 'Thread actions' : ariaLabel}
    aria-hidden={anchorOnly ? 'true' : undefined}
    tabindex={anchorOnly ? -1 : undefined}
    {title}
    oncontextmenu={(e: MouseEvent) => {
      e.preventDefault()
      open = true
      onOpen()
    }}
  >
    {#if !anchorOnly}
      {#if vertical}
        <CioEllipsisVertical size={13} />
      {:else}
        <CioEllipsis size={13} />
      {/if}
    {/if}
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-40 overflow-hidden border bg-surface p-1 shadow-lg"
    >
      {#each items as item (item.label)}
        {#if item.divider}
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
        {:else if item.header}
          <div
            class="truncate px-2.5 pt-1 pb-0.5 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
          >
            {item.label}
          </div>
        {:else}
          <DropdownMenu.Item
            disabled={item.disabled}
            class={[
              'flex w-full items-center gap-2 px-2.5 py-1.5 text-[0.6875rem] outline-none transition-colors max-md:py-2.5',
              item.danger
                ? 'text-danger hover:bg-danger/10 focus:bg-danger/10'
                : 'text-foreground hover:bg-elevated focus:bg-elevated',
              item.disabled ? 'cursor-not-allowed opacity-40' : ''
            ]}
            onSelect={() => {
              item.onClick?.()
            }}
          >
            {#if item.icon}
              {@const Icon = item.icon}
              <Icon size={13} class={item.danger ? '' : 'text-muted'} />
            {/if}
            {item.label}
          </DropdownMenu.Item>
        {/if}
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
