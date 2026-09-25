<script lang="ts">
  /**
   * The sync chooser: which end to trade commits with, which way, and how.
   *
   * Choosing a strategy is the end of this dialog. The run leaves through
   * `gitSyncJobs`, which reports it in a dockable panel at the app root, so a
   * refusal or a conflicted integration never holds the window on a modal the
   * user has to dismiss before they can keep working. What this file reads is
   * the list of ends, which is a fast question about the repository.
   */
  import { onMount } from 'svelte'
  import { Loader2, Search } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { syncStrategyNotes } from './git-sync-copy'
  import type {
    GitPullStrategy,
    GitSyncDirection,
    GitSyncPeer,
    GitSyncPeerOption
  } from '$shared/types'

  interface Props {
    projectId: string
    /** Checkout the sync runs in; undefined is the project root. */
    scopeBucketId: string | undefined
    /** Direction the caller opened with. The chooser can still flip it. */
    initialDirection: GitSyncDirection
    /** End to preselect, when the caller already knows the intent. */
    initialPeer?: GitSyncPeer
    onClose: () => void
    /** Called the moment a strategy is chosen: the run has left, and this is done. */
    onStarted: () => void
    /**
     * Called once the run settles, for a caller that keeps something
     * client-side that a moved ref invalidates (a rendered commit list, say).
     */
    onSettled?: () => void
  }

  let {
    projectId,
    scopeBucketId,
    initialDirection,
    initialPeer,
    onClose,
    onStarted,
    onSettled
  }: Props = $props()

  /** One end that can be picked, plus everything the copy needs about it. */
  interface Entry {
    option: GitSyncPeerOption
    key: string
    /** Sentence shown under the name: the branch, the path, or why it is barred. */
    detail: string
    selectable: boolean
  }

  const directionChoices: { value: GitSyncDirection; label: string }[] = [
    { value: 'from', label: 'Bring commits here' },
    { value: 'to', label: 'Send commits out' }
  ]
  const strategies: { value: GitPullStrategy; label: string }[] = [
    { value: 'ff-only', label: 'Fast-forward only' },
    { value: 'rebase', label: 'Rebase' },
    { value: 'merge', label: 'Merge' }
  ]

  let direction = $state<GitSyncDirection>('from')
  let options = $state<GitSyncPeerOption[]>([])
  let loading = $state(true)
  let selectedKey = $state<string | null>(null)
  let query = $state('')
  let loadError = $state('')

  const busy = $derived(gitState.isBusy('sync'))
  const own = $derived(options.find((option) => option.self) ?? null)
  const ownLabel = $derived(
    own ? `${own.label} (${own.branch ?? 'detached HEAD'})` : 'this checkout'
  )
  const notes = $derived(syncStrategyNotes(direction))

  const entries = $derived(buildEntries(options, direction))
  const visible = $derived(filterEntries(entries, query))
  const checkouts = $derived(visible.filter((entry) => entry.option.checkout))
  const branches = $derived(visible.filter((entry) => !entry.option.checkout))
  const selected = $derived(entries.find((entry) => entry.key === selectedKey) ?? null)
  const chosen = $derived(selected?.selectable === true ? selected : null)

  /**
   * The caller's direction and preselected end are the starting point, applied
   * once on mount: every later change belongs to this dialog, and a caller that
   * re-renders must not yank the user's choice back.
   */
  onMount(() => {
    direction = initialDirection
    selectedKey = initialPeer ? peerKey(initialPeer) : null
    void load()
  })

  async function load(): Promise<void> {
    loading = true
    loadError = ''
    try {
      const loaded = await gitState.syncPeers(projectId, scopeBucketId)
      options = loaded
      selectedKey = keepOrReplace(selectedKey, buildEntries(loaded, direction))
    } catch (reason) {
      loadError = ipcErrorMessage(reason, 'The checkouts and branches could not be read')
    } finally {
      loading = false
    }
  }

  /**
   * Keep the chosen end when it is still pickable, else fall back to the first
   * real alternative. A caller that aimed at the project root while standing in
   * it must never end up syncing the checkout with itself.
   */
  function keepOrReplace(key: string | null, list: Entry[]): string | null {
    const current = list.find((entry) => entry.key === key)
    if (current?.selectable) return key
    return list.find((entry) => entry.selectable)?.key ?? null
  }

  /** Stable key for one end, so a selection survives a reload of the list. */
  function peerKey(peer: GitSyncPeer): string {
    if (peer.kind === 'root') return 'root'
    if (peer.kind === 'worktree') return `worktree:${peer.scopeBucketId}`
    return `branch:${peer.branch}`
  }

  function buildEntries(list: GitSyncPeerOption[], toward: GitSyncDirection): Entry[] {
    return list.map((option) => {
      const bar = barReason(option, toward)
      return {
        option,
        key: peerKey(option.peer),
        // The barred reason takes the detail line, because it is the one thing
        // the user needs to read on a row they cannot pick.
        detail: bar ?? option.branch ?? option.path ?? 'No branch checked out',
        selectable: bar === undefined
      }
    })
  }

  /** Why an end cannot be picked in this direction, when it cannot. */
  function barReason(option: GitSyncPeerOption, toward: GitSyncDirection): string | undefined {
    if (option.unavailable) return option.unavailable
    if (option.self) return 'This is the checkout the sync runs in'
    if (toward === 'to' && !option.checkout) {
      return 'A branch no checkout holds has nowhere to receive commits'
    }
    return undefined
  }

  /** The filter narrows both groups, so a long branch list stays walkable. */
  function filterEntries(list: Entry[], search: string): Entry[] {
    const needle = search.trim().toLowerCase()
    if (!needle) return list
    return list.filter(
      (entry) =>
        entry.option.label.toLowerCase().includes(needle) ||
        (entry.option.branch ?? '').toLowerCase().includes(needle)
    )
  }

  function flip(next: GitSyncDirection): void {
    direction = next
    // A branch cannot receive commits, so flipping to `to` re-validates instead
    // of leaving a selection the footer would silently refuse.
    selectedKey = keepOrReplace(selectedKey, buildEntries(options, next))
  }

  /**
   * Hand the chosen strategy to the sync job and close this chooser.
   *
   * The run itself never reports here: it leaves as a background job
   * (`gitSyncJobs`), so a refusal or a conflicted integration is answered in the
   * docked panel instead of holding the window on a dialog the user has to
   * dismiss before they can keep working.
   */
  function run(strategy: GitPullStrategy): void {
    const target = chosen
    if (!target) return
    gitSyncJobs.start({
      projectId,
      scopeBucketId,
      direction,
      strategy,
      peer: target.option.peer,
      peerLabel: target.option.label,
      ...(onSettled ? { onSettled: () => onSettled() } : {})
    })
    onStarted()
  }
</script>

<Modal {onClose} open size="lg" title={direction === 'from' ? 'Sync from…' : 'Sync to…'}>
  <div class="space-y-4">
    <!--
      The direction is one job seen from two sides, and the menu that opened
      this dialog can only guess which side the user meant, so the guess stays
      correctable here.
    -->
    <div
      class="flex rounded-lg border border-border bg-elevated p-0.5"
      role="group"
      aria-label="Sync direction"
    >
      {#each directionChoices as choice (choice.value)}
        <button
          type="button"
          class={[
            'flex-1 cursor-pointer rounded-md px-2 py-1.5 text-xs font-medium transition-colors',
            direction === choice.value
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'
          ]}
          aria-pressed={direction === choice.value}
          disabled={busy}
          onclick={() => flip(choice.value)}
        >
          {choice.label}
        </button>
      {/each}
    </div>

    <p class="text-xs leading-relaxed text-muted">
      {#if direction === 'from'}
        Commits from the end you pick are integrated into
        <span class="font-medium text-foreground">{ownLabel}</span>.
      {:else}
        Commits from <span class="font-medium text-foreground">{ownLabel}</span> are folded into the end
        you pick. Both checkouts must be committed and idle, and nothing is pushed to a remote.
      {/if}
    </p>

    {#if loading}
      <div class="flex items-center gap-2 px-1 py-6 text-xs text-muted">
        <Loader2 size={13} class="animate-spin" aria-hidden="true" />
        Reading the project's checkouts and branches…
      </div>
    {:else if loadError}
      <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2" role="alert">
        <p class="text-xs font-semibold text-danger">The sync targets could not be read</p>
        <p class="mt-0.5 whitespace-pre-wrap break-words text-xs text-danger">{loadError}</p>
      </div>
    {:else}
      <div class="relative">
        <Search
          size={12}
          class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-dimmed"
          aria-hidden="true"
        />
        <input
          class="w-full rounded-lg border border-border bg-elevated py-1.5 pr-2 pl-7 text-xs text-foreground outline-none focus:border-primary/50"
          placeholder="Filter checkouts and branches"
          aria-label="Filter checkouts and branches"
          bind:value={query}
        />
      </div>

      <div class="max-h-64 space-y-2 overflow-y-auto pr-0.5">
        {#each [{ title: 'Checkouts', items: checkouts }, { title: 'Branches', items: branches }] as group (group.title)}
          {#if group.items.length > 0}
            <p class="px-1 text-xs font-semibold tracking-wide text-dimmed uppercase">
              {group.title}
            </p>
            <div class="space-y-0.5" role="group" aria-label={`Sync ${group.title.toLowerCase()}`}>
              {#each group.items as entry (entry.key)}
                <button
                  type="button"
                  class={[
                    'flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors',
                    entry.key === selectedKey
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-transparent hover:bg-elevated',
                    entry.selectable ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                  ]}
                  aria-pressed={entry.key === selectedKey}
                  aria-disabled={!entry.selectable}
                  title={entry.selectable ? undefined : entry.detail}
                  disabled={!entry.selectable || busy}
                  onclick={() => {
                    selectedKey = entry.key
                  }}
                >
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-xs font-medium text-foreground">
                      {entry.option.label}
                      {#if entry.option.self}<span class="text-dimmed"> · this checkout</span>{/if}
                    </span>
                    <span class="block truncate text-xs text-dimmed">{entry.detail}</span>
                  </span>
                </button>
              {/each}
            </div>
          {/if}
        {/each}
        {#if visible.length === 0}
          <p class="px-1 py-4 text-xs text-muted">
            {query.trim()
              ? 'Nothing here matches that filter.'
              : 'There is no other checkout or branch in this repository to sync with.'}
          </p>
        {/if}
      </div>
    {/if}

    <div class="space-y-1 text-xs leading-relaxed text-dimmed">
      {#each notes as note (note.label)}
        <p>
          <span class="font-medium text-foreground">{note.label}</span>
          {note.note}
        </p>
      {/each}
      <p>
        The run reports in its own panel, so you can keep working while it trades commits with that
        end.
      </p>
    </div>
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        class="cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
        disabled={busy}
        onclick={onClose}
      >
        Cancel
      </button>
      {#each strategies as strategy (strategy.value)}
        <button
          type="button"
          class={[
            'h-8 cursor-pointer rounded-lg px-3 text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-50',
            strategy.value === 'merge'
              ? 'bg-primary text-on-primary hover:bg-primary-hover'
              : 'border border-border text-foreground hover:bg-elevated'
          ]}
          data-modal-primary={strategy.value === 'merge' ? '' : undefined}
          disabled={busy || loading || chosen === null}
          onclick={() => run(strategy.value)}
        >
          {strategy.label}
        </button>
      {/each}
    </div>
  {/snippet}
</Modal>
