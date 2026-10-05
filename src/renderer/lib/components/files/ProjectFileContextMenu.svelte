<script lang="ts">
  import type { Snippet } from 'svelte'
  import { ContextMenu } from 'bits-ui'
  import {
    ClipboardPaste,
    Copy,
    FilePlus2,
    FolderOpen,
    FolderPlus,
    Globe,
    Info,
    Pencil,
    Scissors,
    ShieldCheck,
    ShieldOff,
    Terminal,
    Trash2
  } from '@lucide/svelte'
  import type { ProjectFileEntry } from '$shared/types'
  import type { CioCleanupCategoryId } from '$shared/types/cio-cleanup'
  import type { WorkRoots } from '$shared/design/work-roots'
  import {
    cioCleanupProtectedPaths,
    cioScratchRelativePath,
    isCioCleanupProtectedPath
  } from '$shared/cio-cleanup'
  import { isCioScratchPath } from '$lib/stores/cio-search-visibility.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'

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
    /**
     * Whether the local file manager can show this entry.
     *
     * False for a checkout that lives on an Oven: the absolute path belongs to
     * the remote machine, so a local reveal could only fail.
     */
    canReveal?: boolean
    onOpenInBrowser: () => void
    onOpenInTerminal: () => void
    cioCleanupExcluded: boolean
    onToggleCioCleanupExclusion: () => void
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
    onReveal,
    canReveal = true,
    onOpenInBrowser,
    onOpenInTerminal,
    cioCleanupExcluded,
    onToggleCioCleanupExclusion
  }: Props = $props()

  let selectedCount = $derived(
    entry ? (selectedPaths.includes(entry.path) ? selectedPaths.length : 1) : 0
  )
  let isSingle = $derived(selectedCount <= 1)
  let itemSuffix = $derived(selectedCount > 1 ? ` ${selectedCount} items` : '')
  /** The project root, any directory, and standalone HTML files can be served
   *  over a loopback origin and previewed with their scripts and assets live. */
  let canOpenInBrowser = $derived(
    entry === null || entry.kind === 'directory' || /\.(?:html?|xhtml)$/iu.test(entry.name)
  )
  /**
   * Whether CIO Cleanup never enters this entry, because its folder is one the
   * user excluded from the sweep. A fresh install excludes designs, videos, and
   * installed utilities, and the settings page can change that list.
   *
   * Such an entry has nothing to exclude, so the menu states that instead of
   * offering an exclusion a sweep would not act on. The stored exclusion is still
   * read, so one set before the folder was excluded can be undone here.
   */
  function isProtectedFromCioCleanup(
    entry: ProjectFileEntry | null,
    workRoots: WorkRoots,
    excludedCategories: readonly CioCleanupCategoryId[]
  ) {
    if (entry === null) return false
    const relativePath = cioScratchRelativePath(entry.path)
    if (relativePath === null || relativePath === '') return false
    return isCioCleanupProtectedPath(
      relativePath,
      cioCleanupProtectedPaths(workRoots, excludedCategories)
    )
  }

  /** Any row inside a workspace's `.cio` scratch folder, the folder itself
   *  excepted: it shows how CIO Cleanup treats that row. */
  let cioCleanupRow = $derived(
    entry !== null && entry.path !== '.cio' && isCioScratchPath(entry.path)
  )
  let cioCleanupProtected = $derived(
    isProtectedFromCioCleanup(
      entry,
      appConfigState.workRoots,
      appConfigState.cioCleanupExcludedCategories
    )
  )

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

      {#if canOpenInBrowser}
        <ContextMenu.Item class={itemClass} onSelect={onOpenInBrowser}>
          <Globe size={13} class="text-muted" />
          Open in browser
        </ContextMenu.Item>
      {/if}

      <ContextMenu.Item class={itemClass} onSelect={onOpenInTerminal}>
        <Terminal size={13} class="text-muted" />
        Open in terminal
      </ContextMenu.Item>

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
        {#if canReveal}
          <ContextMenu.Item class={itemClass} onSelect={onReveal}>
            <FolderOpen size={13} class="text-muted" />
            Show in File Manager
          </ContextMenu.Item>
        {/if}
        {#if cioCleanupRow}
          <ContextMenu.Separator class="my-1 h-px bg-border" />
          {#if cioCleanupProtected && !cioCleanupExcluded}
            <ContextMenu.Item
              class={itemClass}
              disabled
              title="This folder is excluded from CIO Cleanup in Settings"

            >
              <ShieldCheck size={13} class="text-muted" />
              Protected from CIO Cleanup
            </ContextMenu.Item>
          {:else}
            <ContextMenu.Item class={itemClass} onSelect={onToggleCioCleanupExclusion}>
              {#if cioCleanupExcluded}
                <ShieldCheck size={13} class="text-muted" />
                Include in CIO Cleanup
              {:else}
                <ShieldOff size={13} class="text-muted" />
                Exclude from CIO Cleanup
              {/if}
            </ContextMenu.Item>
          {/if}
        {/if}
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
