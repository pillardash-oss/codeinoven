<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import {
    Check,
    Ellipsis,
    ListOrdered,
    Maximize2,
    Pencil,
    RefreshCw,
    Trash2,
    WrapText
  } from '@lucide/svelte'

  interface Props {
    diffView: boolean
    lineNumbers: boolean
    wrap: boolean
    reloadDisabled: boolean
    mutationDisabled: boolean
    hideFullscreen?: boolean
    onReload: () => void
    onToggleLineNumbers: () => void
    onToggleWrap: () => void
    onFullscreen: () => void
    onRename: () => void
    onDelete: () => void
  }

  let {
    diffView,
    lineNumbers,
    wrap,
    reloadDisabled,
    mutationDisabled,
    hideFullscreen = false,
    onReload,
    onToggleLineNumbers,
    onToggleWrap,
    onFullscreen,
    onRename,
    onDelete
  }: Props = $props()

  const itemClass =
    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'

  const btnClass =
    'flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground'

  let open = $state(false)
</script>

{#if !hideFullscreen}
  <button
    type="button"
    class={btnClass}
    aria-label="View fullscreen"
    title="Fullscreen"
    onclick={onFullscreen}
  >
    <Maximize2 size={13} />
  </button>
{/if}
{#if !diffView}
  <DropdownMenu.Root bind:open>
    <DropdownMenu.Trigger
      class={btnClass}
      aria-label="File viewer actions"
      title="File viewer actions"
      oncontextmenu={(e: MouseEvent) => {
        e.preventDefault()
        open = true
      }}
    >
      <Ellipsis size={13} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={5}
        avoidCollisions
        collisionPadding={10}
        class="z-50 min-w-52 rounded-lg border border-border bg-surface p-1 shadow-lg"
      >
        <DropdownMenu.Item class={itemClass} disabled={reloadDisabled} onSelect={onReload}>
          <RefreshCw size={13} class="text-muted" />
          Reload file
        </DropdownMenu.Item>
        <DropdownMenu.Item class={itemClass} onSelect={onToggleLineNumbers}>
          <ListOrdered size={13} class="text-muted" />
          <span class="flex-1">{lineNumbers ? 'Hide line numbers' : 'Show line numbers'}</span>
          {#if lineNumbers}
            <Check size={12} class="text-primary" />
          {/if}
        </DropdownMenu.Item>
        <DropdownMenu.Item class={itemClass} onSelect={onToggleWrap}>
          <WrapText size={13} class="text-muted" />
          <span class="flex-1">Wrap</span>
          {#if wrap}
            <Check size={12} class="text-primary" />
          {/if}
        </DropdownMenu.Item>
        <DropdownMenu.Separator class="my-1 h-px bg-border" />
        <DropdownMenu.Item class={itemClass} disabled={mutationDisabled} onSelect={onRename}>
          <Pencil size={13} class="text-muted" />
          Rename
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="{itemClass} text-danger data-[highlighted]:bg-danger/10"
          disabled={mutationDisabled}
          onSelect={onDelete}
        >
          <Trash2 size={13} />
          Delete
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
