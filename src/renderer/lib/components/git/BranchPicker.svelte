<script lang="ts">
  import { ChevronDown, Check, FolderTree, GitBranch, Plus, Search, Trash2 } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import { AlertDialog, DropdownMenu } from 'bits-ui'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { parseRemoteIdentity } from '$lib/git-remote-identity'
  import type { GitBranchInfo } from '$shared/types'

  interface Props {
    branches: GitBranchInfo[]
    currentBranch: string | null
    isBusy: boolean
    /** Primary remote (origin) shown as info at the top of the picker. */
    primaryRemote: { name: string; url: string } | null
    onSelect: (branch: GitBranchInfo) => void
    onCreate?: (name: string) => void
    onDelete?: (name: string) => void
    /** Open the add-origin flow (shown when no remote is configured). */
    onAddOrigin?: () => void
    /** Open the replace-origin flow (shown when a remote is configured). */
    onReplaceOrigin?: () => void
    /**
     * Leading glyph, drawn where the branch icon sits by default. The panel owns
     * it so the working-tree state (clean, dirty, conflicted) stays with the
     * status it comes from. The trigger renders it interactive, where every state
     * but clean is a control that opens the panel's Changes view; the picker's own
     * rows render it bare, where the badge stays a plain mark.
     */
    statusIcon?: Snippet<[boolean]>
    /**
     * Badge for the branch that is checked out, drawn at the end of its row. The
     * panel owns it for the same reason it owns `statusIcon`: the working tree's
     * state comes from the status, not from the branch list. Rendered without
     * the interactive behaviour, since the row it marks is already the branch
     * that is checked out.
     */
    statusBadge?: Snippet<[boolean]>
  }

  let {
    branches,
    currentBranch,
    isBusy,
    primaryRemote,
    onSelect,
    onCreate,
    onDelete,
    onAddOrigin,
    onReplaceOrigin,
    statusIcon,
    statusBadge
  }: Props = $props()

  let open = $state(false)
  let search = $state('')
  let creating = $state(false)
  let newBranchName = $state('')
  let deleteTarget = $state<string | null>(null)

  /**
   * The panel's own control inside the trigger, marked by the panel. Activating
   * one is that control's business: the trigger must neither open the picker on
   * the way through nor leave one open underneath it.
   */
  const STATUS_ACTION_SELECTOR = '[data-status-action]'

  const filtered = $derived(
    search.trim()
      ? branches.filter((b) => b.ref.toLowerCase().includes(search.toLowerCase()))
      : branches
  )

  const localBranches = $derived(
    filtered.filter((branch) => branch.kind === 'local' && branch.worktreePath === null)
  )
  const worktreeBranches = $derived(
    filtered.filter((branch) => branch.kind === 'local' && branch.worktreePath !== null)
  )
  const remoteBranches = $derived(filtered.filter((branch) => branch.kind === 'remote'))
  const localNames = $derived(
    new Set(branches.filter((branch) => branch.kind === 'local').map((branch) => branch.name))
  )
  const remoteIdentity = $derived(parseRemoteIdentity(primaryRemote?.url))

  function handleSelect(branch: GitBranchInfo): void {
    if (branch.kind === 'local' && branch.name === currentBranch) return
    if (branch.kind === 'remote' && localNames.has(branch.name)) return
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

  /**
   * The trigger opens the picker from its own pointer events   a mouse toggles
   * on `pointerdown`, touch on `pointerup`   so a gesture that starts on the
   * panel's control cancels the one it would toggle on, and the branch list
   * stays shut unless the gesture lands anywhere else on the trigger.
   *
   * Cancelled rather than stopped on purpose. bits-ui composes its own handlers
   * with these and skips its own once the event is cancelled, while a stopped
   * event would never reach the layers that dismiss the menus around this one,
   * leaving a stray open menu behind when the badge takes the user elsewhere.
   */
  function guardStatusActionPointer(event: PointerEvent): void {
    if (!isStatusActionEvent(event)) return
    if (event.type === 'pointerup' && event.pointerType !== 'touch') return
    event.preventDefault()
  }

  /**
   * A status badge inside the trigger opens the Changes view, so a click that
   * landed on one closes the picker instead of dragging it along to the next view.
   * `preventDefault` keeps the trigger's own click handler out of the loop (it is
   * what also covers the click a screen reader sends for the badge, which arrives
   * with no keyboard event in front of it); the click is left to bubble, so every
   * other layer still sees the interaction and no focus is lost by the click
   * being cancelled.
   */
  function handleTriggerClick(event: MouseEvent): void {
    if (!isStatusActionEvent(event)) return
    open = false
    event.preventDefault()
  }

  /** Whether an event is the panel's own control inside the trigger acting, rather than the trigger itself. */
  function isStatusActionEvent(event: Event): boolean {
    const target = event.target
    return target instanceof Element && target.closest(STATUS_ACTION_SELECTOR) !== null
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
    class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50 data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    disabled={isBusy}
    title={currentBranch ? `Switch branch (${currentBranch})` : 'Switch branch'}
    aria-label={currentBranch ? `Switch branch, currently ${currentBranch}` : 'Switch branch'}
    onpointerdown={guardStatusActionPointer}
    onpointerup={guardStatusActionPointer}
    onclick={handleTriggerClick}
  >
    {#if statusIcon}
      {@render statusIcon(true)}
    {:else}
      <GitBranch size={11} class="shrink-0" />
    {/if}
    <!--
      Wide enough for a real branch name (`feature/git-panel-redesign`) instead
      of the ten characters this used to cap at. `truncate` keeps its automatic
      minimum size at zero, so the branch name is what gives way when the row is
      tight instead of the tab strip and the tool buttons beside it. The name is
      in the trigger's tooltip for when it does truncate.
    -->
    <span class="max-w-[26ch] truncate">{currentBranch ?? 'detached'}</span>
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
      <!-- Origin -->
      {#if primaryRemote}
        <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
          <VendorIcon
            name={remoteIdentity?.platform === 'gitlab' ? 'GitLab' : 'GitHub'}
            size={12}
            class="shrink-0 text-dimmed"
          />
          <span class="min-w-0 flex-1 truncate font-mono text-[0.5625rem] text-dimmed">
            {remoteIdentity?.path ?? primaryRemote.url}
          </span>
          {#if onReplaceOrigin}
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Replace origin ({primaryRemote.name})"
              onclick={onReplaceOrigin}
            >
              Replace
            </button>
          {/if}
        </div>
      {:else if onAddOrigin}
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-1.5 border-b border-border px-3 py-1.5 text-[0.625rem] font-medium text-muted outline-none transition-colors hover:bg-elevated hover:text-foreground"
          title="Add a git remote so you can fetch and push"
          aria-label="Add Git Origin"
          onclick={onAddOrigin}
        >
          <Plus size={11} class="shrink-0" />
          Add Git Origin
        </button>
      {/if}

      <div class="border-b border-border px-3 py-2">
        <div class="flex items-center gap-2 rounded-lg bg-elevated px-2 py-1">
          <Search size={12} class="shrink-0 text-dimmed" />
          <input
            class="min-w-0 flex-1 bg-transparent font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search branches…"
            bind:value={search}
            onkeydown={handleKeydown}
          />
        </div>
      </div>

      <div class="max-h-60 overflow-y-auto py-1">
        {#if localBranches.length > 0}
          <p class="px-3 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
            Local
          </p>
          {#each localBranches as branch (branch.ref)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] outline-none transition-colors hover:bg-elevated"
              onclick={() => handleSelect(branch)}
              onkeydown={(e: KeyboardEvent) => e.key === 'Enter' && handleSelect(branch)}
            >
              <GitBranch size={11} class="shrink-0 text-dimmed" />
              <span class="min-w-0 flex-1 truncate text-left text-foreground">{branch.name}</span>
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
              {#if branch.current}
                {#if statusBadge}
                  {@render statusBadge(false)}
                {/if}
                <Check size={12} class="shrink-0 text-primary" />
              {:else if onDelete}
                <button
                  type="button"
                  class="shrink-0 cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
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

        {#if worktreeBranches.length > 0}
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          <p class="px-3 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
            Worktrees
          </p>
          {#each worktreeBranches as branch (branch.ref)}
            <div
              class="flex w-full items-center gap-2 px-3 py-1.5 text-[0.6875rem] outline-none"
              title={`Checked out in worktree ${branch.worktreePath ?? ''}`}
            >
              <FolderTree size={11} class="shrink-0 text-warning" />
              <span class="min-w-0 flex-1 truncate text-left text-muted">{branch.name}</span>
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
              <span
                class="shrink-0 rounded bg-warning/10 px-1 py-0.5 text-[0.5rem] font-semibold uppercase tracking-wide text-warning"
              >
                worktree
              </span>
            </div>
          {/each}
        {/if}

        {#if remoteBranches.length > 0}
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          <p class="px-3 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed">
            Remote
          </p>
          {#each remoteBranches as branch (branch.ref)}
            <button
              type="button"
              class={[
                'flex w-full items-center gap-2 px-3 py-1.5 text-[0.6875rem] outline-none transition-colors',
                localNames.has(branch.name)
                  ? 'cursor-default opacity-60'
                  : 'cursor-pointer hover:bg-elevated'
              ]}
              title={localNames.has(branch.name)
                ? `${branch.ref} already has a local branch`
                : `Create local branch ${branch.name} from ${branch.ref}`}
              disabled={localNames.has(branch.name)}
              onclick={() => handleSelect(branch)}
            >
              <GitBranch size={11} class="shrink-0 text-dimmed" />
              <span class="min-w-0 flex-1 truncate text-left text-muted">{branch.ref}</span>
              {#if localNames.has(branch.name)}
                <span class="shrink-0 text-[0.5625rem] text-dimmed">local exists</span>
              {/if}
            </button>
          {/each}
        {/if}

        {#if filtered.length === 0}
          <p class="px-3 py-2 text-center text-[0.625rem] text-dimmed">No branches found</p>
        {/if}
      </div>

      <div class="border-t border-border px-3 py-2">
        {#if creating}
          <div class="flex items-center gap-1.5">
            <input
              class="min-w-0 flex-1 rounded-md border border-border bg-elevated px-2 py-1 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder="new-feature"
              bind:value={newBranchName}
              onkeydown={handleKeydown}
            />
            <button
              type="button"
              class="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-[0.625rem] font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={!newBranchName.trim()}
              onclick={handleCreate}
            >
              Create
            </button>
          </div>
        {:else}
          <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-2 text-[0.6875rem] text-muted outline-none transition-colors hover:text-foreground"
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
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={confirmDelete}
        >
          Delete
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
