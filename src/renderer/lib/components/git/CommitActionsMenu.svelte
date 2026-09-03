<script lang="ts">
  import { GitCommit, RotateCcw, Copy, MessageSquareText, Trash2 } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitResetMode } from '$shared/types'

  interface Props {
    isHead: boolean
    resetBusy?: boolean
    deleteBusy?: boolean
    onReset: (mode: GitResetMode) => void
    onDelete: () => void
    onAmend?: () => void
    onCopyHash: () => void
    onCopyMessage: () => void
  }

  let {
    isHead,
    resetBusy = false,
    deleteBusy = false,
    onReset,
    onDelete,
    onAmend,
    onCopyHash,
    onCopyMessage
  }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40'
</script>

<DropdownMenu.Item class={itemClass} onSelect={onCopyHash} disabled={resetBusy || deleteBusy}>
  <Copy size={12} class="shrink-0 text-dimmed" />
  Copy commit hash
</DropdownMenu.Item>
<DropdownMenu.Item class={itemClass} onSelect={onCopyMessage} disabled={resetBusy || deleteBusy}>
  <MessageSquareText size={12} class="shrink-0 text-dimmed" />
  Copy commit message
</DropdownMenu.Item>

<DropdownMenu.Separator class="my-1 h-px bg-border" />

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger class={itemClass} disabled={resetBusy || deleteBusy}>
    <RotateCcw size={12} class="shrink-0 text-dimmed" />
    Reset to here…
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent
    class="z-50 min-w-56 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
    sideOffset={4}
  >
    <DropdownMenu.Item class={itemClass} onSelect={() => onReset('soft')} disabled={resetBusy}>
      <span class="w-3 text-center text-[0.625rem] text-success">±</span>
      Soft
      <span class="ml-auto pl-3 text-[0.5625rem] text-dimmed">keep index + worktree</span>
    </DropdownMenu.Item>
    <DropdownMenu.Item class={itemClass} onSelect={() => onReset('mixed')} disabled={resetBusy}>
      <span class="w-3 text-center text-[0.625rem] text-warning">±</span>
      Mixed
      <span class="ml-auto pl-3 text-[0.5625rem] text-dimmed">keep worktree</span>
    </DropdownMenu.Item>
    <DropdownMenu.Item class={itemClass} onSelect={() => onReset('hard')} disabled={resetBusy}>
      <span class="w-3 text-center text-[0.625rem] text-danger">×</span>
      Hard
      <span class="ml-auto pl-3 text-[0.5625rem] text-dimmed">discard all</span>
    </DropdownMenu.Item>
  </DropdownMenu.SubContent>
</DropdownMenu.Sub>

{#if isHead && onAmend}
  <DropdownMenu.Item class={itemClass} onSelect={onAmend} disabled={resetBusy || deleteBusy}>
    <GitCommit size={12} class="shrink-0 text-dimmed" />
    Amend commit message
  </DropdownMenu.Item>
{/if}

<DropdownMenu.Separator class="my-1 h-px bg-border" />

<DropdownMenu.Item
  class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
  onSelect={onDelete}
  disabled={deleteBusy || resetBusy}
>
  <Trash2 size={12} class="shrink-0" />
  Delete commit
</DropdownMenu.Item>
