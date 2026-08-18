<script lang="ts">
  import type { Snippet } from 'svelte'
  import { ContextMenu } from 'bits-ui'
  import {
    ClipboardPaste,
    Copy,
    FilePlus2,
    FolderOpen,
    FolderPlus,
    Info,
    Pencil,
    Scissors,
    Trash2
  } from '@lucide/svelte'
  import type { ProjectFileEntry } from '$shared/types'

  interface Props {
    entry: ProjectFileEntry | null
    selectedPaths: string[]
    canPaste: boolean
    children: Snippet
    onCreateFile: () => void
    onCreateFolder: () => void
    onCopy: () => void
    onCopyPath: () => void
    onCut: () => void
    onPaste: () => void
    onRename: () => void
    onDelete: () => void
    onInfo: () => void
    onReveal: () => void
  }

  let {
    entry,
    selectedPaths,
    canPaste,
    children,
    onCreateFile,
    onCreateFolder,
    onCopy,
    onCopyPath,
    onCut,
    onPaste,
    onRename,
    onDelete,
    onInfo,
    onReveal
  }: Props = $props()

  let selectedCount = $derived(
    entry ? (selectedPaths.includes(entry.path) ? selectedPaths.length : 1) : 0
  )
  let isSingle = $derived(selectedCount <= 1)
  let itemSuffix = $derived(selectedCount > 1 ? ` ${selectedCount} items` : '')

  const itemClass =
    'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="contents">
    {@render children()}
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      avoidCollisions
      collisionPadding={12}
      sticky="always"
      updatePositionStrategy="always"
      class="z-50 max-h-[calc(100vh-1.5rem)] min-w-44 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      {#if !entry || entry.kind === 'directory'}
        <ContextMenu.Item class={itemClass} onSelect={onCreateFile}>
          <FilePlus2 size={13} class="text-muted" />
          New file
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={onCreateFolder}>
          <FolderPlus size={13} class="text-muted" />
          New folder
        </ContextMenu.Item>
      {/if}

      {#if entry}
        <ContextMenu.Item class={itemClass} disabled={!canPaste} onSelect={onPaste}>
          <ClipboardPaste size={13} class="text-muted" />
          Paste
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={onCopy}>
          <Copy size={13} class="text-muted" />
          Copy{itemSuffix}
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={onCut}>
          <Scissors size={13} class="text-muted" />
          Move{itemSuffix}
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={onCopyPath}>
          <Copy size={13} class="text-muted" />
          {selectedCount > 1 ? `Copy ${selectedCount} paths` : 'Copy path'}
        </ContextMenu.Item>
        <ContextMenu.Item class={itemClass} onSelect={onReveal}>
          <FolderOpen size={13} class="text-muted" />
          Show in File Manager
        </ContextMenu.Item>
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        {#if isSingle}
          <ContextMenu.Item class={itemClass} onSelect={onRename}>
            <Pencil size={13} class="text-muted" />
            Rename
          </ContextMenu.Item>
        {/if}
        <ContextMenu.Item
          class="{itemClass} text-danger data-[highlighted]:bg-danger/10"
          onSelect={onDelete}
        >
          <Trash2 size={13} />
          Delete{itemSuffix}
        </ContextMenu.Item>
      {/if}

      {#if entry && isSingle}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item class={itemClass} onSelect={onInfo}>
          <Info size={13} class="text-muted" />
          File info
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
