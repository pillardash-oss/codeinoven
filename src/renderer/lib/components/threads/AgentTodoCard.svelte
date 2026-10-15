<script lang="ts">
  import { ListChecks, TriangleAlert, X } from '@lucide/svelte'
  import CardStack from '../shared/CardStack.svelte'
  import { activeAgentTodoIndex, type AgentTodoItem } from '$lib/agent-todos'

  interface Props {
    items: AgentTodoItem[]
    signature: string
    busy: boolean
    /** The run is over, so the list on screen is a record and not live progress. */
    stopped: boolean
    /**
     * Another CodeInOven instance is streaming this thread's turn right now.
     * `busy` is false here because none of that stream reaches this window, so
     * without this the list would report a live run as stopped.
     */
    foreign?: boolean
    /** Dismiss the card after the thread stopped working. */
    onClose: () => void
  }

  let { items, signature, busy, stopped, foreign = false, onClose }: Props = $props()

  let open = $state(false)
  let userPinnedOpen = $state(false)
  let lastSignature = $state('')

  let completedCount = $derived(items.filter((item) => item.status === 'completed').length)
  let activeIndex = $derived(activeAgentTodoIndex(items, busy))
  /**
   * What the list is, in one reading. A run another window is streaming is live
   * work, not a stopped one: the item that is marked active is marked by that
   * window's activity, and calling it "Stopped" here contradicts the transfer
   * card sitting under it.
   */
  let chip = $derived(
    foreign
      ? { text: 'Live elsewhere' }
      : busy
        ? { text: 'Running' }
        : { text: 'Stopped', tone: 'urgent' as const }
  )
  /**
   * The turn stopped with tasks it never completed, so the list on screen is a
   * record of where the run left off and not live progress. Naming that state
   * keeps a reader from taking an abandoned list for the app having lost track.
   */
  let stoppedUnfinished = $derived(stopped && items.some((item) => item.status !== 'completed'))

  /**
   * The stack's fold control writes `folded` directly, so expose `!open` through
   * a getter/setter: unfolding pins the card open and folding clears the pin,
   * exactly what the old header toggle did before the control moved into the head.
   */
  const foldState = {
    get folded(): boolean {
      return !open
    },
    set folded(value: boolean) {
      open = !value
      userPinnedOpen = !value
    }
  }

  $effect(() => {
    const currentSignature = signature
    if (currentSignature === lastSignature) return
    lastSignature = currentSignature
    if (userPinnedOpen) {
      open = true
      return
    }
    open = true
    const timer = window.setTimeout(() => {
      if (!userPinnedOpen) open = false
    }, 4_000)
    return () => window.clearTimeout(timer)
  })
</script>

<CardStack
  label="Agent task progress"
  icon={ListChecks}
  title="Tasks"
  {chip}
  warn={stoppedUnfinished}
  bind:folded={foldState.folded}
  foldLabel="task list"
>
  {#snippet meta()}
    <span class="border border-border px-1.5 py-0.5 text-[0.6875rem] tabular-nums text-foreground">
      {completedCount}/{items.length}
    </span>
    {#if stoppedUnfinished}
      <span class="flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium text-warning">
        <TriangleAlert size={12} class="shrink-0" />
        Agent did not finish their turn
      </span>
    {/if}
  {/snippet}

  {#snippet controls()}
    <!-- Only offered once the turn stops, so a closed card can never hide live
    task progress. -->
    {#if !busy}
      <button
        type="button"
        class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Close task list"
        title="Close task list"
        onclick={onClose}
      >
        <X size={13} />
      </button>
    {/if}
  {/snippet}

  {#snippet body()}
    <div class="max-h-56 overflow-y-auto px-3 py-2" aria-live="polite">
      <ul class="space-y-1.5">
        {#each items as item, index (`${item.id}-${index}`)}
          <li class="flex items-start gap-2 text-xs">
            <span
              class="mt-1 h-2 w-2 shrink-0 {item.status === 'completed'
                ? 'bg-success'
                : index === activeIndex
                  ? 'bg-info'
                  : 'border border-border-strong'}"
            ></span>
            <span
              class:line-through={item.status === 'completed'}
              class:text-dimmed={item.status === 'completed'}
              class:text-foreground={item.status !== 'completed'}
              class="min-w-0 flex-1 leading-relaxed"
            >
              {item.label}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/snippet}
</CardStack>
