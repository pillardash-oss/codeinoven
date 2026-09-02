<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Ellipsis,
    FolderInput,
    GitBranch,
    GitMerge,
    Pencil,
    Pin,
    PinOff,
    Trash2,
    RefreshCw,
    Wrench
  } from '@lucide/svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket } from '$shared/types'

  export type ScopeMenuAction =
    | 'edit'
    | 'pin'
    | 'unpin'
    | 'archive'
    | 'restore'
    | 'create-worktree'
    | 'adopt-worktree'
    | 'retry-setup'
    | 'repair-worktree'
    | 'merge'
    | 'detach'
    | 'delete'

  interface Props {
    bucket: ScopeBucket
    onEdit: () => void
    onDelete: () => void
    /** Provided only on surfaces where pinning is allowed (the scope view). */
    onTogglePinned?: () => void
    onArchive?: () => void
    onRestore?: () => void
    onCreateWorktree?: () => void
    onAdoptWorktree?: () => void
    onRetrySetup?: () => void
    onRepairWorktree?: () => void
    /** Cached health reports a repairable managed-worktree problem. */
    hasRepairableIssue?: boolean
    onMerge?: () => void
    onDetach?: () => void
  }

  let {
    bucket,
    onEdit,
    onDelete,
    onTogglePinned,
    onArchive,
    onRestore,
    onCreateWorktree,
    onAdoptWorktree,
    onRetrySetup,
    onRepairWorktree,
    hasRepairableIssue = false,
    onMerge,
    onDetach
  }: Props = $props()

  let showMenu = $state(false)

  const isManaged = $derived(bucket.root.kind === 'worktree')
  const isArchived = $derived(bucket.archivedAt !== undefined)
  const setupFailed = $derived(
    isManaged &&
      bucket.root.kind === 'worktree' &&
      (bucket.root.setup.state === 'failed' || bucket.root.setup.state === 'interrupted')
  )

  function closeMenu(): void {
    showMenu = false
  }

  interface Item {
    label: string
    run: () => void
  }

  const items: Item[] = $derived(
    (() => {
      const list: Item[] = []
      list.push({
        label: 'Edit',
        run: () => {
          closeMenu()
          onEdit()
        }
      })
      if (onTogglePinned && bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: bucket.pinned ? 'Unpin scope' : 'Pin scope',
          run: () => {
            closeMenu()
            onTogglePinned()
          }
        })
      }
      if (bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        if (isArchived) {
          list.push({
            label: 'Restore',
            run: () => {
              onRestore?.()
              closeMenu()
            }
          })
        } else {
          list.push({
            label: 'Archive',
            run: () => {
              onArchive?.()
              closeMenu()
            }
          })
        }
      }
      if (!isManaged && bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: 'Create Git worktree',
          run: () => {
            onCreateWorktree?.()
            closeMenu()
          }
        })
        list.push({
          label: 'Adopt Git worktree…',
          run: () => {
            onAdoptWorktree?.()
            closeMenu()
          }
        })
      }
      if (isManaged && hasRepairableIssue) {
        list.push({
          label: 'Repair worktree',
          run: () => {
            onRepairWorktree?.()
            closeMenu()
          }
        })
      }
      if (isManaged) {
        list.push({
          label: 'Merge into project…',
          run: () => {
            onMerge?.()
            closeMenu()
          }
        })
        if (setupFailed) {
          list.push({
            label: 'Retry setup',
            run: () => {
              onRetrySetup?.()
              closeMenu()
            }
          })
        }
        list.push({
          label: 'Detach worktree',
          run: () => {
            onDetach?.()
            closeMenu()
          }
        })
      }
      if (bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: 'Delete scope',
          run: () => {
            closeMenu()
            onDelete()
          }
        })
      }
      return list
    })()
  )
</script>

<div class="relative shrink-0">
  <button
    class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
    aria-label={`Actions for ${bucket.name}`}
    aria-haspopup="menu"
    aria-expanded={showMenu}
    title="Scope actions"
    onclick={() => (showMenu = !showMenu)}
    oncontextmenu={(e: MouseEvent) => {
      e.preventDefault()
      showMenu = true
    }}
  >
    <Ellipsis size={14} />
  </button>
  {#if showMenu}
    <button
      class="fixed inset-0 z-40 cursor-default"
      aria-label="Close scope actions"
      onclick={closeMenu}
    ></button>
    <div
      class="absolute right-0 top-8 z-50 w-52 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
      role="menu"
    >
      {#each items as item (item.label)}
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-elevated"
          role="menuitem"
          onclick={item.run}
        >
          {#if item.label === 'Retry setup'}
            <RefreshCw size={13} class="text-muted" />
          {:else if item.label === 'Repair worktree'}
            <Wrench size={13} class="text-muted" />
          {:else if item.label === 'Adopt Git worktree…'}
            <FolderInput size={13} class="text-muted" />
          {:else if item.label === 'Archive'}
            <Archive size={13} class="text-muted" />
          {:else if item.label === 'Restore'}
            <ArchiveRestore size={13} class="text-muted" />
          {:else if item.label === 'Delete scope'}
            <Trash2 size={13} class="text-muted" />
          {:else if item.label === 'Edit'}
            <Pencil size={13} class="text-muted" />
          {:else if item.label === 'Merge into project…'}
            <GitMerge size={13} class="text-muted" />
          {:else if item.label === 'Pin scope' || item.label === 'Unpin scope'}
            {#if item.label === 'Pin scope'}
              <Pin size={13} class="text-muted" />
            {:else}
              <PinOff size={13} class="text-muted" />
            {/if}
          {:else}
            <GitBranch size={13} class="text-muted" />
          {/if}
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
