<script lang="ts">
  import CioCommit from '@codeinoven/icons/CioCommit.svelte'
  import CioCopy from '@codeinoven/icons/CioCopy.svelte'
  import CioMessage from '@codeinoven/icons/CioMessage.svelte'
  import CioTabInfo from '@codeinoven/icons/CioTabInfo.svelte'
  import CioTrash from '@codeinoven/icons/CioTrash.svelte'
  import CioUndo from '@codeinoven/icons/CioUndo.svelte'
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
    /** Reveals the full commit record (hash, author, parents, message). */
    onShowInfo?: () => void
  }

  let {
    isHead,
    resetBusy = false,
    deleteBusy = false,
    onReset,
    onDelete,
    onAmend,
    onCopyHash,
    onCopyMessage,
    onShowInfo
  }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40'
</script>

{#if onShowInfo}
  <DropdownMenu.Item class={itemClass} onSelect={onShowInfo} disabled={resetBusy || deleteBusy}>
    <CioTabInfo size={12} class="shrink-0 text-dimmed" />
    Commit info
  </DropdownMenu.Item>
  <DropdownMenu.Separator class="my-1 h-px bg-border" />
{/if}

<DropdownMenu.Item class={itemClass} onSelect={onCopyHash} disabled={resetBusy || deleteBusy}>
  <CioCopy size={12} class="shrink-0 text-dimmed" />
  Copy commit hash
</DropdownMenu.Item>
<DropdownMenu.Item class={itemClass} onSelect={onCopyMessage} disabled={resetBusy || deleteBusy}>
  <CioMessage size={12} class="shrink-0 text-dimmed" />
  Copy commit message
</DropdownMenu.Item>

<DropdownMenu.Separator class="my-1 h-px bg-border" />

<DropdownMenu.Sub>
  <DropdownMenu.SubTrigger class={itemClass} disabled={resetBusy || deleteBusy}>
    <CioUndo size={12} class="shrink-0 text-dimmed" />
    Reset to here…
  </DropdownMenu.SubTrigger>
  <DropdownMenu.SubContent
    class="z-50 min-w-56 overflow-hidden border border-border bg-surface p-1 shadow-xl"
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
    <CioCommit size={12} class="shrink-0 text-dimmed" />
    Amend commit message
  </DropdownMenu.Item>
{/if}

<DropdownMenu.Separator class="my-1 h-px bg-border" />

<DropdownMenu.Item
  class="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-[0.6875rem] text-danger outline-none data-highlighted:bg-elevated disabled:pointer-events-none disabled:opacity-40"
  onSelect={onDelete}
  disabled={deleteBusy || resetBusy}
>
  <CioTrash size={12} class="shrink-0" />
  Delete commit
</DropdownMenu.Item>
