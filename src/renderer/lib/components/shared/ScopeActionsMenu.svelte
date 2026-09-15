<script lang="ts">
  import {
    Archive,
    ArchiveRestore,
    Ellipsis,
    FolderInput,
    GitBranch,
    GitMerge,
    PanelsLeftBottom,
    Pencil,
    Pin,
    PinOff,
    Trash2,
    RefreshCw,
    Wrench
  } from '@lucide/svelte'
  import type { Component, Snippet } from 'svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket } from '$shared/types'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { hasRepairableScopeIssue, scopeState } from '$lib/stores/scope.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import type { ScopeActionsController } from '../scope/ScopeActionsController.svelte'

  interface Props {
    bucket: ScopeBucket
    /** Owns every scope action this menu can trigger. */
    actions: ScopeActionsController
    /** Custom trigger content (e.g. the scope badge); defaults to an ellipsis icon. */
    trigger?: Snippet
    triggerClass?: string
    triggerTitle?: string
    /** Positions the menu panel relative to the trigger. */
    menuClass?: string
  }

  let {
    bucket,
    actions,
    trigger,
    triggerClass = 'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground',
    triggerTitle = 'Scope actions',
    menuClass = 'right-0 top-8'
  }: Props = $props()

  let showMenu = $state(false)

  const isManaged = $derived(bucket.root.kind === 'worktree')
  const isArchived = $derived(bucket.archivedAt !== undefined)
  const setupFailed = $derived(
    isManaged &&
      bucket.root.kind === 'worktree' &&
      (bucket.root.setup.state === 'failed' || bucket.root.setup.state === 'interrupted')
  )
  /** Cached health of this scope; drives the repair item like the board's warning button. */
  const repairable = $derived(hasRepairableScopeIssue(scopeState.healthFor(bucket.id)))
  /**
   * Dock puts a scope into the scoped-threads sidebar. While that sidebar
   * already shows this very scope, docking again only re-navigates (and drops
   * the focused thread), so the item is offered only when it changes something.
   * The scope board renders this same menu and stays fully dockable, since the
   * sidebar is not the destination there.
   */
  const alreadyDocked = $derived(
    scopeState.sidebarContext?.bucketId === bucket.id &&
      (rendererRecovery.activeView === 'projects' ||
        rendererRecovery.activeView === 'projects-scope')
  )

  /**
   * A live harness session in this scope keeps its process in the directory the
   * scope points at right now. Creating or adopting a worktree moves that root,
   * which would leave the running session stranded in the old directory while
   * every later turn resolves to the new one, so both options are withheld
   * until the scope's threads settle. `isConversationBusy` covers interactive
   * sessions only, so background work (Brainstorm report generation) never
   * hides them.
   */
  const scopeHasLiveSession = $derived(
    scopeState.allScopeThreads.some(
      (thread) =>
        thread.projectId === actions.projectId &&
        !thread.archived &&
        scopeState.bucketForThread(thread) === bucket.id &&
        agentRuns.isConversationBusy(thread.projectId, thread.id)
    )
  )

  function closeMenu(): void {
    showMenu = false
  }

  interface Item {
    label: string
    icon: Component
    run: () => void
  }

  const items: Item[] = $derived(
    (() => {
      const list: Item[] = []
      if (!alreadyDocked) {
        list.push({
          label: 'Dock',
          icon: PanelsLeftBottom,
          run: () => {
            closeMenu()
            actions.dock(bucket)
          }
        })
      }
      list.push({
        label: 'Edit',
        icon: Pencil,
        run: () => {
          closeMenu()
          actions.askEdit(bucket)
        }
      })
      if (bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: bucket.pinned ? 'Unpin scope' : 'Pin scope',
          icon: bucket.pinned ? PinOff : Pin,
          run: () => {
            closeMenu()
            void actions.togglePinned(bucket)
          }
        })
        if (isArchived) {
          list.push({
            label: 'Restore',
            icon: ArchiveRestore,
            run: () => {
              closeMenu()
              void actions.setArchived(bucket, false)
            }
          })
        } else {
          list.push({
            label: 'Archive',
            icon: Archive,
            run: () => {
              closeMenu()
              void actions.setArchived(bucket, true)
            }
          })
        }
      }
      if (!isManaged && bucket.id !== DEFAULT_SCOPE_BUCKET_ID && !scopeHasLiveSession) {
        list.push({
          label: 'Create Git worktree',
          icon: GitBranch,
          run: () => {
            closeMenu()
            actions.askCreateWorktree(bucket)
          }
        })
        list.push({
          label: 'Adopt Git worktree…',
          icon: FolderInput,
          run: () => {
            closeMenu()
            actions.askAdoptWorktree(bucket)
          }
        })
      }
      if (isManaged && repairable) {
        list.push({
          label: 'Repair worktree',
          icon: Wrench,
          run: () => {
            closeMenu()
            void actions.repairWorktree(bucket)
          }
        })
      }
      if (isManaged) {
        list.push({
          label: 'Merge into project…',
          icon: GitMerge,
          run: () => {
            closeMenu()
            actions.askMerge(bucket)
          }
        })
        if (setupFailed) {
          list.push({
            label: 'Retry setup',
            icon: RefreshCw,
            run: () => {
              closeMenu()
              void actions.retrySetup(bucket)
            }
          })
        }
        list.push({
          label: 'Detach worktree',
          icon: GitBranch,
          run: () => {
            closeMenu()
            actions.openLifecycle(bucket, 'detach')
          }
        })
      }
      if (bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: 'Delete scope',
          icon: Trash2,
          run: () => {
            closeMenu()
            actions.askDelete(bucket)
          }
        })
      }
      return list
    })()
  )
</script>

<div class="relative shrink-0">
  <button
    class={triggerClass}
    aria-label={`Actions for ${bucket.name}`}
    aria-haspopup="menu"
    aria-expanded={showMenu}
    title={triggerTitle}
    onclick={() => (showMenu = !showMenu)}
    oncontextmenu={(e: MouseEvent) => {
      e.preventDefault()
      showMenu = true
    }}
  >
    {#if trigger}
      {@render trigger()}
    {:else}
      <Ellipsis size={14} />
    {/if}
  </button>
  {#if showMenu}
    <button
      class="fixed inset-0 z-40 cursor-default"
      aria-label="Close scope actions"
      onclick={closeMenu}
    ></button>
    <div
      class="absolute {menuClass} z-50 w-52 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
      role="menu"
    >
      {#each items as item (item.label)}
        {@const Icon = item.icon}
        <button
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground hover:bg-elevated"
          role="menuitem"
          onclick={item.run}
        >
          <Icon size={13} class="text-muted" />
          {item.label}
        </button>
      {/each}
    </div>
  {/if}
</div>
