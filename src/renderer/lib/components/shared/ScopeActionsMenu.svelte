<script lang="ts">
  import { osFileManagerLabel } from '$lib/os-file-manager'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { isScopeWorktreeHealthRepairable } from '$shared/scope-worktree-health'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket } from '$shared/types'
  import {
    Archive,
    ArchiveRestore,
    Ellipsis,
    FolderInput,
    FolderOpen,
    GitBranch,
    GitCompare,
    GitMerge,
    PanelsLeftBottom,
    Pencil,
    Pin,
    PinOff,
    RefreshCw,
    Trash2,
    Wrench
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Component, Snippet } from 'svelte'
  import type { ScopeActionsController } from '../scope/ScopeActionsController.svelte'

  interface Props {
    bucket: ScopeBucket
    /** Owns every scope action this menu can trigger. */
    actions: ScopeActionsController
    /** Custom trigger content (e.g. the scope badge); defaults to an ellipsis icon. */
    trigger?: Snippet
    triggerClass?: string
    triggerTitle?: string
  }

  let {
    bucket,
    actions,
    trigger,
    triggerClass = 'flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground',
    triggerTitle = 'Scope actions'
  }: Props = $props()

  let showMenu = $state(false)

  const isManaged = $derived(bucket.root.kind === 'worktree')

  /**
   * Opening the menu is an interaction with the scope, so it re-reads the
   * checkout's real state before the items (Repair worktree, Re-run setup) are
   * evaluated against it.
   */
  function handleOpenChange(open: boolean): void {
    const projectId = actions.projectId
    if (!open || !isManaged || !projectId) return
    void scopeState.revalidateWorktreeHealth(projectId, bucket.id).catch(() => undefined)
  }
  const isArchived = $derived(bucket.archivedAt !== undefined)
  const setupFailed = $derived(
    isManaged &&
      bucket.root.kind === 'worktree' &&
      (bucket.root.setup.state === 'failed' || bucket.root.setup.state === 'interrupted')
  )
  /** Cached health of this scope; drives the repair item like the board's warning button. */
  const repairable = $derived(isScopeWorktreeHealthRepairable(scopeState.healthFor(bucket.id)))
  /**
   * A `stale` setup state means the checkout was re-created after setup had run,
   * so its dependencies and build output have to be produced again.
   */
  const setupStale = $derived(
    isManaged && bucket.root.kind === 'worktree' && bucket.root.setup.state === 'stale'
  )
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
   * every later turn resolves to the new one, so both options stay disabled
   * until the scope's threads settle. `isConversationBusy` covers interactive
   * sessions only, so background work (Brainstorm report generation) never
   * disables them.
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

  /** Tooltip and ARIA text for the worktree items while a session owns this scope. */
  const liveSessionReason =
    'A thread in this scope is in session. Wait for it to finish before creating or adopting a worktree.'

  interface Item {
    label: string
    icon: Component
    run: () => void
    /** When set, the item renders disabled and this text explains why. */
    disabledReason?: string
  }

  const items: Item[] = $derived(
    (() => {
      const list: Item[] = []
      if (!alreadyDocked) {
        list.push({
          label: 'Dock',
          icon: PanelsLeftBottom,
          run: () => actions.dock(bucket)
        })
      }
      list.push({
        label: 'Edit',
        icon: Pencil,
        run: () => actions.askEdit(bucket)
      })
      if (bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: bucket.pinned ? 'Unpin scope' : 'Pin scope',
          icon: bucket.pinned ? PinOff : Pin,
          run: () => void actions.togglePinned(bucket)
        })
        if (isArchived) {
          list.push({
            label: 'Restore',
            icon: ArchiveRestore,
            run: () => void actions.setArchived(bucket, false)
          })
        } else {
          list.push({
            label: 'Archive',
            icon: Archive,
            run: () => void actions.setArchived(bucket, true)
          })
        }
      }
      if (!isManaged && bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: 'Create Git worktree',
          icon: GitBranch,
          run: () => actions.askCreateWorktree(bucket),
          ...(scopeHasLiveSession ? { disabledReason: liveSessionReason } : {})
        })
        list.push({
          label: 'Adopt Git worktree…',
          icon: FolderInput,
          run: () => actions.askAdoptWorktree(bucket),
          ...(scopeHasLiveSession ? { disabledReason: liveSessionReason } : {})
        })
      }
      if (isManaged) {
        if (repairable) {
          list.push({
            label: 'Repair worktree',
            icon: Wrench,
            run: () => void actions.repairWorktree(bucket)
          })
        }
        // The checkout is a real directory the user may want in their own file
        // manager (to inspect, diff or hand work over), so it is one click away
        // through the same reveal contract the file surfaces use.
        list.push({
          label: osFileManagerLabel(),
          icon: FolderOpen,
          run: () => void actions.revealWorktree(bucket)
        })
        list.push({
          label: 'Merge into project…',
          icon: GitMerge,
          run: () => actions.askMerge(bucket)
        })
        list.push({
          label: 'Sync Worktree',
          icon: GitCompare,
          run: () => actions.askSyncFrom(bucket)
        })
        if (setupFailed || setupStale) {
          list.push({
            label: setupStale ? 'Re-run setup' : 'Retry setup',
            icon: RefreshCw,
            run: () => void actions.retrySetup(bucket)
          })
        }
        list.push({
          label: 'Detach worktree',
          icon: GitBranch,
          run: () => actions.openLifecycle(bucket, 'detach')
        })
      }
      if (bucket.id !== DEFAULT_SCOPE_BUCKET_ID) {
        list.push({
          label: 'Delete scope',
          icon: Trash2,
          run: () => actions.askDelete(bucket)
        })
      }
      return list
    })()
  )
</script>

<!--
  A portaled `bits-ui` menu, not a positioned child: the sidebar, the scope board
  and the scoped-threads sidebar all clip their own overflow and are narrow, so
  an in-flow panel is cut off exactly when the scope sits near an edge. The
  portal plus `collisionPadding` keeps every item reachable wherever the trigger
  happens to be.
-->
<DropdownMenu.Root bind:open={showMenu} onOpenChange={handleOpenChange}>
  <DropdownMenu.Trigger
    class={triggerClass}
    aria-label={`Actions for ${bucket.name}`}
    title={triggerTitle}
    oncontextmenu={(event: MouseEvent) => {
      // Right-clicking a scope is how the sidebar has always offered this menu;
      // the popup still anchors to the trigger, so the pointer position is not
      // what decides where it opens.
      event.preventDefault()
      showMenu = true
    }}
  >
    {#if trigger}
      {@render trigger()}
    {:else}
      <Ellipsis size={14} />
    {/if}
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 max-h-80 w-52 overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      {#each items as item (item.label)}
        {@const Icon = item.icon}
        <DropdownMenu.Item
          class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-60"
          textValue={item.label}
          title={item.disabledReason}
          disabled={Boolean(item.disabledReason)}
          onSelect={item.run}
        >
          <Icon size={13} class="shrink-0 text-muted" />
          {item.label}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
