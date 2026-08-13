<script lang="ts">
  import { CircleCheck, Download, GitBranch, Trash2 } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'

  interface Props {
    isCurrent: boolean
    canFetch: boolean
    busy?: boolean
    onCheckout: () => void
    onFetch: () => void
    onDelete: () => void
  }

  let { isCurrent, canFetch, busy = false, onCheckout, onFetch, onDelete }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40'
</script>

{#if isCurrent}
  <DropdownMenu.Item class={itemClass} disabled>
    <CircleCheck size={12} class="shrink-0 text-primary" />
    Current branch
  </DropdownMenu.Item>
{:else}
  <DropdownMenu.Item class={itemClass} onSelect={onCheckout} disabled={busy}>
    <GitBranch size={12} class="shrink-0 text-dimmed" />
    Check out
  </DropdownMenu.Item>
{/if}

{#if canFetch}
  <DropdownMenu.Item class={itemClass} onSelect={onFetch} disabled={busy}>
    <Download size={12} class="shrink-0 text-dimmed" />
    Fetch this branch
  </DropdownMenu.Item>
{/if}

{#if !isCurrent}
  <DropdownMenu.Separator class="my-1 h-px bg-border" />
  <DropdownMenu.Item
    class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[11px] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
    onSelect={onDelete}
    disabled={busy}
  >
    <Trash2 size={12} class="shrink-0" />
    Delete branch
  </DropdownMenu.Item>
{/if}
