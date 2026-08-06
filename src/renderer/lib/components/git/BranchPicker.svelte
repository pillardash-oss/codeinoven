<script lang="ts">
  import { ChevronDown, Check, GitBranch, Plus, Search } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitBranchInfo } from '$shared/types'

  interface Props {
    branches: GitBranchInfo[]
    currentBranch: string | null
    isBusy: boolean
    onSelect: (branch: string) => void
  }

  let { branches, currentBranch, isBusy, onSelect }: Props = $props()

  let open = $state(false)
  let search = $state('')

  const filtered = $derived(
    search.trim()
      ? branches.filter((b) => b.name.toLowerCase().includes(search.toLowerCase()))
      : branches
  )

  const localBranches = $derived(filtered.filter((b) => !b.remote))
  const remoteBranches = $derived(filtered.filter((b) => b.remote))

  function handleSelect(branch: string): void {
    if (branch === currentBranch) return
    onSelect(branch)
    open = false
    search = ''
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      open = false
      search = ''
    }
  }
</script>

<DropdownMenu.Root bind:open onOpenChange={() => (search = '')}>
  <DropdownMenu.Trigger
    class="flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[11px] font-medium text-foreground transition-colors hover:bg-elevated disabled:opacity-50 data-[state=open]:bg-elevated data-[state=open]:border-primary/40"
    disabled={isBusy}
    title="Switch branch"
    aria-label="Switch branch"
  >
    <GitBranch size={12} class="shrink-0 text-muted" />
    <span class="max-w-[12ch] truncate">{currentBranch ?? 'detached'}</span>
    <ChevronDown size={11} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-56 overflow-hidden rounded-xl border bg-surface shadow-xl"
    >
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
            Branches
          </p>
          {#each localBranches as branch (branch.name)}
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => handleSelect(branch.name)}
            >
              <GitBranch size={11} class="shrink-0 text-dimmed" />
              <span class="min-w-0 flex-1 truncate text-foreground">{branch.name}</span>
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
              {/if}
            </DropdownMenu.Item>
          {/each}
        {/if}

        {#if remoteBranches.length > 0}
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          <p class="px-3 py-1 text-[9px] font-semibold uppercase tracking-wide text-dimmed">
            Remote
          </p>
          {#each remoteBranches as branch (branch.name)}
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-3 py-1.5 text-[11px] outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => handleSelect(branch.name)}
            >
              <GitBranch size={11} class="shrink-0 text-dimmed" />
              <span class="min-w-0 flex-1 truncate text-muted">{branch.remote}/{branch.name}</span>
              {#if branch.current}
                <Check size={12} class="shrink-0 text-primary" />
              {/if}
            </DropdownMenu.Item>
          {/each}
        {/if}

        {#if filtered.length === 0}
          <p class="px-3 py-2 text-center text-[10px] text-dimmed">No branches found</p>
        {/if}
      </div>

      <div class="border-t border-border">
        <DropdownMenu.Item
          class="flex w-full items-center gap-2 px-3 py-2 text-[11px] text-muted outline-none transition-colors hover:bg-elevated hover:text-foreground focus:bg-elevated"
          onSelect={() => {
            /* TODO: create branch flow */
          }}
        >
          <Plus size={12} class="shrink-0" />
          Create and checkout new branch…
        </DropdownMenu.Item>
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
