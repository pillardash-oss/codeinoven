<script lang="ts">
  import CioAttention from '@codeio/icon/CioAttention.svelte'
  import CioClose from '@codeio/icon/CioClose.svelte'
  import CioListChecks from '@codeio/icon/CioListChecks.svelte'
  import { fly } from 'svelte/transition'
  import CardStack from '../shared/CardStack.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import { rowArrive } from '../shared/card-motion'
  import { activeAgentTodoIndex, agentTodoCounter, type AgentTodoItem } from '$lib/agent-todos'

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
    /** Another card sits directly above the list, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** Thread the task list belongs to, so the reader's fold choice is remembered. */
    threadId: string
    /** Dismiss the card after the thread stopped working. */
    onClose: () => void
  }

  let {
    items,
    signature,
    busy,
    stopped,
    foreign = false,
    stackedAbove = false,
    threadId,
    onClose
  }: Props = $props()

  /** The reader's own fold choice for this thread's task list, if they made one.
   *  Without it the card keeps its transient behaviour: it opens on new activity
   *  and folds itself again after a moment. */
  // svelte-ignore state_referenced_locally
  const foldPreference = threadCardFold.preferenceFor(threadId, 'todo')
  let open = $state(foldPreference === undefined ? false : !foldPreference)
  let userPinnedOpen = $state(foldPreference === false)
  let userPinnedClosed = $state(foldPreference === true)
  let lastSignature = $state('')

  /**
   * A run that is live, wherever it streams from: this window's own turn, or the
   * one another instance is streaming. Either way the list on screen is live
   * progress and the task the run is on has to be named.
   */
  let live = $derived(busy || foreign)
  let activeIndex = $derived(activeAgentTodoIndex(items, live))
  let counter = $derived(agentTodoCounter(items, activeIndex))
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
      userPinnedClosed = value
      threadCardFold.setFolded(threadId, 'todo', value)
    }
  }

  $effect(() => {
    const currentSignature = signature
    if (currentSignature === lastSignature) return
    lastSignature = currentSignature
    if (userPinnedClosed) {
      open = false
      return
    }
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
  icon={CioListChecks}
  title="Tasks"
  {chip}
  warn={stoppedUnfinished}
  {stackedAbove}
  bind:folded={foldState.folded}
  foldLabel="task list"
>
  {#snippet meta()}
    <span
      class="border border-border px-1.5 py-0.5 text-[0.6875rem] tabular-nums text-foreground"
      title={counter.meaning}
    >
      {counter.value}/{items.length}
    </span>
    <span class="sr-only">{counter.meaning}</span>
    {#if stoppedUnfinished}
      <span class="flex shrink-0 items-center gap-1 text-[0.6875rem] font-medium text-warning">
        <CioAttention size={12} class="shrink-0" />
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
        <CioClose size={13} />
      </button>
    {/if}
  {/snippet}

  {#snippet body()}
    <div class="max-h-56 overflow-y-auto px-3 py-2" aria-live="polite">
      <ul class="space-y-1.5">
        <!-- A task the agent adds arrives as a row; a task that changes state
           inks to its new colour where it stands, so progress reads as movement
           in the list the user is already watching rather than a redraw. -->
        {#each items as item, index (`${item.id}-${index}`)}
          <li class="flex items-start gap-2 text-xs" in:fly={rowArrive()}>
            <span
              class="mt-1 h-2 w-2 shrink-0 transition-colors {item.status === 'completed'
                ? 'bg-success'
                : index === activeIndex
                  ? 'bg-info'
                  : 'border border-border-strong'}"
            ></span>
            <span
              class:line-through={item.status === 'completed'}
              class:text-dimmed={item.status === 'completed'}
              class:text-foreground={item.status !== 'completed'}
              class="min-w-0 flex-1 leading-relaxed transition-colors"
            >
              {item.label}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {/snippet}
</CardStack>
