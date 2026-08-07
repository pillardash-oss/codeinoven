<script lang="ts">
  import { Ellipsis } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Component } from 'svelte'

  export interface MenuItem {
    label: string
    icon?: Component
    onClick?: () => void
    danger?: boolean
    divider?: boolean
    disabled?: boolean
  }

  interface Props {
    items: MenuItem[]
    title?: string
    ariaLabel?: string
    onOpen?: () => void
    /** Fired when the menu closes — lets a touch reveal undo itself. */
    onClose?: () => void
    open?: boolean
  }

  let {
    items,
    title = 'Thread actions',
    ariaLabel = 'Thread actions',
    onOpen = () => undefined,
    onClose = () => undefined,
    open = $bindable(false)
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
    class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    aria-label={ariaLabel}
    {title}
    oncontextmenu={(e: MouseEvent) => {
      e.preventDefault()
      open = true
      onOpen()
    }}
  >
    <Ellipsis size={13} />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-40 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
    >
      {#each items as item (item.label)}
        {#if item.divider}
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
        {:else}
          <DropdownMenu.Item
            disabled={item.disabled}
            class={[
              'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors max-md:py-2.5',
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
