<script lang="ts">
  import { FolderTree, GitBranch, MoreHorizontal } from '@lucide/svelte'
  import { ContextMenu, DropdownMenu } from 'bits-ui'
  import type { GitBranchInfo } from '$shared/types'
  import { gitState } from '$lib/stores/git.svelte'
  import BranchActionsMenu from './BranchActionsMenu.svelte'
  import { branchAvatarClass } from './git-status-panel-format'

  interface Props {
    branches: GitBranchInfo[]
    localBranches: GitBranchInfo[]
    worktreeBranches: GitBranchInfo[]
    localBranchNames: Set<string>
    creatingBranch: boolean
    newBranchName: string
    onCreateBranch: (name: string) => void
    onRequestCheckout: (branch: GitBranchInfo) => void
    onFetchBranch: (branch: GitBranchInfo) => void
    onRequestDeleteBranch: (name: string) => void
    onRequestDeleteRemoteBranch: (branch: GitBranchInfo) => void
  }

  let {
    branches,
    localBranches,
    worktreeBranches,
    localBranchNames,
    creatingBranch = $bindable(),
    newBranchName = $bindable(),
    onCreateBranch,
    onRequestCheckout,
    onFetchBranch,
    onRequestDeleteBranch,
    onRequestDeleteRemoteBranch
  }: Props = $props()

  let newBranchInput = $state<HTMLInputElement | null>(null)

  $effect(() => {
    if (creatingBranch) newBranchInput?.focus()
  })

  function cancelNewBranch(): void {
    creatingBranch = false
    newBranchName = ''
  }

  function submitNewBranch(): void {
    const name = newBranchName.trim()
    if (!name) return
    creatingBranch = false
    newBranchName = ''
    onCreateBranch(name)
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!--
    The New branch control lives in the header's action section, so this
    row appears only while a name is being typed: the list keeps the whole
    panel height the rest of the time.
  -->
  {#if creatingBranch}
    <div class="shrink-0 border-b border-border px-3 py-1.5">
      <div class="flex items-center gap-1.5">
        <input
          bind:this={newBranchInput}
          class="min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 py-1 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="new-feature"
          bind:value={newBranchName}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter') submitNewBranch()
            if (event.key === 'Escape') cancelNewBranch()
          }}
        />
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
          disabled={!newBranchName.trim() || gitState.isBusy('checkout')}
          onclick={submitNewBranch}
        >
          Create
        </button>
        <button
          type="button"
          class="shrink-0 cursor-pointer rounded-md px-2 py-1 text-[0.625rem] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={cancelNewBranch}
        >
          Cancel
        </button>
      </div>
    </div>
  {/if}

  <div class="min-h-0 flex-1 overflow-y-auto p-2">
    {#if branches.length === 0}
      <div class="flex flex-col items-center justify-center py-12 text-center">
        <GitBranch size={22} class="mx-auto mb-2 text-dimmed" />
        <p class="text-xs font-medium text-muted">No branches</p>
      </div>
    {:else}
      {@const branchSections = [
        {
          key: 'local',
          label: 'Local',
          branches: [...localBranches].sort((a, b) => {
            if (a.current !== b.current) return a.current ? -1 : 1
            return a.ref.localeCompare(b.ref)
          })
        },
        {
          key: 'worktrees',
          label: 'Worktrees',
          branches: [...worktreeBranches].sort((a, b) => a.ref.localeCompare(b.ref))
        },
        {
          key: 'remote',
          label: 'Remote',
          branches: [...branches]
            .filter((branch) => branch.kind === 'remote')
            .sort((a, b) => a.ref.localeCompare(b.ref))
        }
      ].filter((section) => section.branches.length > 0)}
      <div class="space-y-0.5">
        {#each branchSections as section (section.key)}
          <p
            class="px-2 pb-1 pt-2 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
          >
            {section.label}
          </p>
          {#each section.branches as branch (branch.ref)}
            {@const canFetch = Boolean(branch.remote)}
            {@const inWorktree = branch.worktreePath !== null}
            {@const hasLocalCounterpart =
              branch.kind === 'remote' && localBranchNames.has(branch.name)}
            <ContextMenu.Root>
              <ContextMenu.Trigger
                class="block w-full"
                aria-label={`Actions for branch ${branch.ref}`}
              >
                <div
                  class="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-elevated/50"
                >
                  <span
                    class={[
                      'flex size-5 shrink-0 items-center justify-center rounded-full',
                      inWorktree ? 'bg-warning/10 text-warning' : branchAvatarClass(branch.ref)
                    ]}
                  >
                    {#if inWorktree}
                      <FolderTree size={11} />
                    {:else}
                      <GitBranch size={11} />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <button
                      type="button"
                      class="block w-full cursor-pointer truncate text-left text-[0.6875rem] text-foreground disabled:cursor-default"
                      disabled={branch.current || hasLocalCounterpart || inWorktree}
                      title={branch.current
                        ? undefined
                        : inWorktree
                          ? `Checked out in worktree ${branch.worktreePath ?? ''}   git allows a branch in only one worktree`
                          : hasLocalCounterpart
                            ? `${branch.ref} already has a local branch`
                            : branch.kind === 'local'
                              ? `Check out ${branch.name}`
                              : `Create local branch ${branch.name} from ${branch.ref}`}
                      onclick={() => onRequestCheckout(branch)}
                    >
                      {branch.kind === 'local' ? branch.name : branch.ref}
                    </button>
                    {#if branch.kind === 'local' && branch.upstream}
                      <span class="block truncate text-[0.5625rem] text-dimmed">
                        tracks {branch.upstream}
                      </span>
                    {:else if inWorktree}
                      <span class="block truncate text-[0.5625rem] text-dimmed">
                        checked out in worktree
                      </span>
                    {:else if branch.kind === 'remote'}
                      <span class="block truncate text-[0.5625rem] text-dimmed">
                        {hasLocalCounterpart ? 'local branch exists' : 'remote branch'}
                      </span>
                    {/if}
                  </span>
                  {#if inWorktree}
                    <span
                      class="shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-warning"
                    >
                      worktree
                    </span>
                  {/if}
                  {#if branch.ahead > 0 || branch.behind > 0}
                    <span class="flex shrink-0 items-center gap-0.5 text-[0.5625rem] tabular-nums">
                      {#if branch.ahead > 0}
                        <span class="text-success">+{branch.ahead}</span>
                      {/if}
                      {#if branch.behind > 0}
                        <span class="text-danger">−{branch.behind}</span>
                      {/if}
                    </span>
                  {/if}
                  <div class="relative h-6 w-16 shrink-0">
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger
                        class="peer absolute inset-y-0 right-0 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-dimmed opacity-0 transition-opacity hover:bg-elevated hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                        aria-label={`More actions for branch ${branch.ref}`}
                        title={`More actions for branch ${branch.ref}`}
                      >
                        <MoreHorizontal size={13} />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                          side="bottom"
                          align="end"
                          sideOffset={4}
                          collisionPadding={8}
                        >
                          <BranchActionsMenu
                            isCurrent={branch.current}
                            canCheckout={!hasLocalCounterpart && !inWorktree}
                            canDelete={branch.kind === 'local'}
                            canDeleteRemote={branch.kind === 'remote'}
                            {canFetch}
                            checkoutLabel={branch.kind === 'local'
                              ? 'Check out'
                              : 'Create local branch'}
                            busy={gitState.isBusy('checkout')}
                            fetchBusy={gitState.isBusy('fetch')}
                            remoteBusy={gitState.isBusy('push')}
                            onCheckout={() => onRequestCheckout(branch)}
                            onFetch={() => onFetchBranch(branch)}
                            onDelete={() => onRequestDeleteBranch(branch.name)}
                            onDeleteRemote={() => onRequestDeleteRemoteBranch(branch)}
                          />
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                    {#if branch.current}
                      <span
                        class="pointer-events-none absolute inset-y-0 right-0 flex items-center whitespace-nowrap rounded bg-primary/15 px-1.5 text-[0.5rem] font-semibold text-primary opacity-100 transition-opacity group-hover:opacity-0 peer-hover:opacity-0 peer-data-[state=open]:opacity-0"
                      >
                        current
                      </span>
                    {/if}
                  </div>
                </div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content
                  class="z-50 min-w-48 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-xl"
                  side="bottom"
                  align="start"
                  sideOffset={4}
                  collisionPadding={8}
                >
                  <BranchActionsMenu
                    isCurrent={branch.current}
                    canCheckout={!hasLocalCounterpart && !inWorktree}
                    canDelete={branch.kind === 'local'}
                    canDeleteRemote={branch.kind === 'remote'}
                    {canFetch}
                    checkoutLabel={branch.kind === 'local' ? 'Check out' : 'Create local branch'}
                    busy={gitState.isBusy('checkout')}
                    fetchBusy={gitState.isBusy('fetch')}
                    remoteBusy={gitState.isBusy('push')}
                    onCheckout={() => onRequestCheckout(branch)}
                    onFetch={() => onFetchBranch(branch)}
                    onDelete={() => onRequestDeleteBranch(branch.name)}
                    onDeleteRemote={() => onRequestDeleteRemoteBranch(branch)}
                  />
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          {/each}
        {/each}
      </div>
    {/if}
  </div>
</div>
