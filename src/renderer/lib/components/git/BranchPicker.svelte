<script lang="ts">
  import {
    ChevronDown,
    Check,
    GitBranch,
    Plus,
    Search,
    Trash2,
    LogOut,
    GitFork,
    ExternalLink,
    ChevronRight,
    User
  } from '@lucide/svelte'
  import { AlertDialog, DropdownMenu } from 'bits-ui'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import type { GitBranchInfo, GitHubAuthStatus } from '$shared/types'

  interface Props {
    branches: GitBranchInfo[]
    currentBranch: string | null
    isBusy: boolean
    /** Primary remote (origin) shown as info at the top of the picker. */
    primaryRemote: { name: string; url: string } | null
    /** GitHub account status surfaced in the picker header. */
    github: GitHubAuthStatus
    onSelect: (branch: string) => void
    onCreate?: (name: string) => void
    onDelete?: (name: string) => void
    onSignIn: () => void
    onSignOut: () => void
  }

  let {
    branches,
    currentBranch,
    isBusy,
    primaryRemote,
    github,
    onSelect,
    onCreate,
    onDelete,
    onSignIn,
    onSignOut
  }: Props = $props()

  let open = $state(false)
  let search = $state('')
  let creating = $state(false)
  let newBranchName = $state('')
  let deleteTarget = $state<string | null>(null)

  const filtered = $derived(
    search.trim()
      ? branches.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()))
      : branches
  )

  const localBranches = $derived(filtered.filter((b) => !b.remote))
  const remoteBranches = $derived(filtered.filter((b) => b.remote))

  const githubUser = $derived(github.user ?? null)

  /** Browsable https URL for the remote, from either an ssh or https origin. */
  const remoteWebUrl = $derived.by(() => {
    const url = primaryRemote?.url?.trim()
    if (!url) return null
    const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(url)
    if (ssh) return `https://${ssh[1]}/${ssh[2]}`
    if (/^https?:\/\//.test(url)) return url.replace(/\.git$/, '')
    return null
  })

  async function openUrl(url: string): Promise<void> {
    open = false
    await openInBrowser(url)
  }

  function handleSelect(branch: string): void {
    if (branch === currentBranch) return
    onSelect(branch)
    open = false
    search = ''
    creating = false
    newBranchName = ''
  }

  function handleCreate(): void {
    const name = newBranchName.trim()
    if (!name || !onCreate) return
    onCreate(name)
    open = false
    search = ''
    creating = false
    newBranchName = ''
  }

  function handleDelete(event: MouseEvent, name: string): void {
    event.stopPropagation()
    deleteTarget = name
  }

  function confirmDelete(): void {
    if (!deleteTarget || !onDelete) return
    onDelete(deleteTarget)
    deleteTarget = null
    open = false
    search = ''
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      open = false
      search = ''
      creating = false
      newBranchName = ''
    }
    if (event.key === 'Enter' && creating) {
      handleCreate()
    }
  }
</script>

<DropdownMenu.Root
  bind:open
  onOpenChange={() => {
    search = ''
    creating = false
    newBranchName = ''
  }}
>
  <DropdownMenu.Trigger
    class="flex h-7 items-center gap-1 rounded-md px-2 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50 data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    disabled={isBusy}
    title="Switch branch"
    aria-label="Switch branch"
  >
    <GitBranch size={11} class="shrink-0" />
    <span class="max-w-[10ch] truncate">{currentBranch ?? 'detached'}</span>
    <ChevronDown size={10} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-60 overflow-hidden rounded-xl border bg-surface shadow-xl"
    >
      <!-- GitHub account -->
      <div class="border-b border-border px-3 py-2">
        {#if github.connected && githubUser}
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger
              class="flex w-full items-center gap-2 rounded-md px-1 py-1 outline-none transition-colors hover:bg-elevated data-[state=open]:bg-elevated"
              title="GitHub account actions"
              aria-label="GitHub account actions"
            >
              <img
                src={githubUser.avatarUrl}
                alt=""
                class="h-6 w-6 shrink-0 rounded-full bg-elevated"
              />
              <div class="min-w-0 flex-1 text-left">
                <p class="truncate text-[11px] font-medium text-foreground">
                  {githubUser.name ?? githubUser.login}
                </p>
                <p class="truncate text-[9px] text-dimmed">@{githubUser.login}</p>
              </div>
              <ChevronRight size={12} class="shrink-0 text-dimmed" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent
              sideOffset={6}
              class="z-50 w-56 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
            >
              {#if remoteWebUrl}
                <DropdownMenu.Item
                  class="flex cursor-default items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
                  onSelect={() => void openUrl(remoteWebUrl)}
                >
                  <ExternalLink size={12} class="shrink-0 text-dimmed" />
                  Open repository on GitHub
                </DropdownMenu.Item>
              {/if}
              <DropdownMenu.Item
                class="flex cursor-default items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
                onSelect={() => void openUrl(`https://github.com/${githubUser.login}`)}
              >
                <User size={12} class="shrink-0 text-dimmed" />
                View my GitHub profile
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex cursor-default items-center gap-2 px-3 py-1.5 text-[11px] text-foreground outline-none transition-colors data-highlighted:bg-elevated"
                onSelect={() => void openUrl('https://github.com/pulls')}
              >
                <GitFork size={12} class="shrink-0 text-dimmed" />
                My pull requests
              </DropdownMenu.Item>
              <DropdownMenu.Separator class="my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex cursor-default items-center gap-2 px-3 py-1.5 text-[11px] text-danger outline-none transition-colors data-highlighted:bg-danger/10"
                onSelect={() => {
                  open = false
                  onSignOut()
                }}
              >
                <LogOut size={12} class="shrink-0" />
                Sign out of GitHub
              </DropdownMenu.Item>
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        {:else if github.configured}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-md border border-border px-2 py-1.5 text-[11px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Sign in to GitHub"
            onclick={(e: MouseEvent) => {
              e.stopPropagation()
              open = false
              onSignIn()
            }}
          >
            <VendorIcon name="GitHub" size={13} class="shrink-0" />
            Sign in to GitHub
          </button>
        {:else}
          <p class="px-1 text-[9px] leading-relaxed text-dimmed">
            GitHub sign-in needs a client ID to be configured.
          </p>
        {/if}
      </div>

      <!-- Origin -->
      {#if primaryRemote}
        <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <GitFork size={11} class="shrink-0 text-dimmed" />
          <span class="min-w-0 flex-1 truncate font-mono text-[9px] text-dimmed">
            {primaryRemote.name}: {primaryRemote.url}
          </span>
        </div>
      {/if}

      <div class="border-b border-border px-3 py-2">
        <div class="flex items-center gap-2 rounded-lg bg-elevated px-2 py-1">
          <Search size={12} class="shrink-0 text-dimmed" />
          <input
            class="min-w-0 flex-1 bg-transparent font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search branches…"
            bind:value={search}
            onkeydown={handleKeydown}
          />
        </div>
      </div>

      <div class="max-h-60 overflow-y-auto py-1">
        {#if localBranches.length > 0}
          <p class="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-dimmed">
            Local
          </p>
          {#each localBranches as branch (branch.name)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] outline-none transition-colors hover:bg-elevated"
              onclick={() => handleSelect(branch.name)}
              onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleSelect(branch.name)}
            >
              <GitBranch size={11} class="shrink-0 text-dimmed" />
              <span class="min-w-0 flex-1 truncate text-left text-foreground">{branch.name}</span>
              {#if branch.ahead > 0 || branch.behind > 0}
                <span class="flex shrink-0 items-center gap-0.5 text-[9px] tabular-nums">
                  {#if branch.ahead > 0}
                    <span class="text-success">+{branch.ahead}</span>
                  {/if}
                  {#if branch.behind > 0}
                    <span class="text-danger">−{branch.behind}</span>
                  {/if}
                </span>
              {/if}
              {#if branch.current}
                <Check size={12} class="shrink-0 text-primary" />
              {:else if onDelete}
                <button
                  type="button"
                  class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                  title="Delete branch {branch.name}"
                  aria-label="Delete branch {branch.name}"
                  onclick={(e: MouseEvent) => handleDelete(e, branch.name)}
                >
                  <Trash2 size={12} />
                </button>
              {/if}
            </div>
          {/each}
        {/if}

        {#if remoteBranches.length > 0}
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          <p class="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-dimmed">
            Remote
          </p>
          {#each remoteBranches as branch (branch.name)}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] outline-none transition-colors hover:bg-elevated"
              onclick={() => handleSelect(branch.name)}
            >
              <GitBranch size={11} class="shrink-0 text-dimmed" />
              <span class="min-w-0 flex-1 truncate text-left text-muted"
                >{branch.remote}/{branch.name}</span
              >
              {#if branch.current}
                <Check size={12} class="shrink-0 text-primary" />
              {/if}
            </button>
          {/each}
        {/if}

        {#if filtered.length === 0}
          <p class="px-3 py-2 text-center text-[10px] text-dimmed">No branches found</p>
        {/if}
      </div>

      <div class="border-t border-border px-3 py-2">
        {#if creating}
          <div class="flex items-center gap-1.5">
            <input
              class="min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 py-1 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder="new-feature"
              bind:value={newBranchName}
              onkeydown={handleKeydown}
            />
            <button
              type="button"
              class="shrink-0 rounded-md bg-primary px-2 py-1 text-[10px] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={!newBranchName.trim()}
              onclick={handleCreate}
            >
              Create
            </button>
          </div>
        {:else}
          <button
            type="button"
            class="flex w-full items-center gap-2 text-[11px] text-muted outline-none transition-colors hover:text-foreground"
            onclick={() => (creating = true)}
          >
            <Plus size={12} class="shrink-0" />
            New branch…
          </button>
        {/if}
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

<AlertDialog.Root open={deleteTarget !== null} onOpenChange={() => (deleteTarget = null)}>
  <AlertDialog.Portal>
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Delete branch?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Branch <strong class="text-foreground">{deleteTarget}</strong> will be permanently deleted. This
        cannot be undone.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={confirmDelete}
        >
          Delete
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
