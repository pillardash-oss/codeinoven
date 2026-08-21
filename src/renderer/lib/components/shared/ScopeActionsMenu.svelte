<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Ellipsis,
    GitBranch,
    Pencil,
    Trash2,
    RefreshCw
  } from '@lucide/svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket } from '$shared/types'

  export type ScopeMenuAction =
    | 'edit'
    | 'archive'
    | 'restore'
    | 'create-worktree'
    | 'retry-setup'
    | 'detach'
    | 'remove-worktree'
    | 'delete-branch'
    | 'delete'

  interface Props {
    bucket: ScopeBucket
    onEdit: () => void
    onDelete: () => void
    onArchive?: () => void
    onRestore?: () => void
    onCreateWorktree?: () => void
    onRetrySetup?: () => void
    onDetach?: () => void
    onRemoveWorktree?: () => void
    onDeleteBranch?: () => void
  }

  let {
    bucket,
    onEdit,
    onDelete,
    onArchive,
    onRestore,
    onCreateWorktree,
    onRetrySetup,
    onDetach,
    onRemoveWorktree,
    onDeleteBranch
  }: Props = $props()

  let showMenu = $state(false)

  const isManaged = bucket.root.kind === 'worktree'
  const isArchived = bucket.archivedAt !== undefined
  const setupFailed =
    isManaged &&
    bucket.root.kind === 'worktree' &&
    (bucket.root.setup.state === 'failed' || bucket.root.setup.state === 'interrupted')

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
      }
      if (isManaged) {
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
          label: 'Detach to project root',
          run: () => {
            onDetach?.()
            closeMenu()
          }
        })
        list.push({
          label: 'Remove worktree',
          run: () => {
            onRemoveWorktree?.()
            closeMenu()
          }
        })
        list.push({
          label: 'Delete branch',
          run: () => {
            onDeleteBranch?.()
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
  {#if isManaged}
    <span
      class="pointer-events-none mr-0.5 inline-flex -space-x-1.5 items-center"
      title="Managed Git worktree scope"
    >
      <GitBranch size={13} class="text-muted" />
    </span>
  {/if}
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
          {:else if item.label === 'Archive'}
            <Archive size={13} class="text-muted" />
          {:else if item.label === 'Restore'}
            <ArchiveRestore size={13} class="text-muted" />
          {:else if item.label === 'Delete scope' || item.label === 'Delete branch'}
            <Trash2 size={13} class="text-muted" />
          {:else if item.label === 'Edit'}
            <Pencil size={13} class="text-muted" />
          {:else}
            <GitBranch size={13} class="text-muted" />
          {/if}
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
