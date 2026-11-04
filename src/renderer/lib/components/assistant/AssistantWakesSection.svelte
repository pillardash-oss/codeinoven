<script lang="ts">
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import { followUpsState } from '$lib/stores/follow-ups.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { relativeTimeClock } from '$lib/relative-time.svelte'
  import { formatDateTimeWithWeekday } from '$shared/date-time-format'
  import type { Assistant, Thread } from '$shared/types'

  /**
   * The wakes an assistant's threads have armed on themselves.
   *
   * A wake belongs to a thread, not to the assistant, so this section resolves the
   * assistant's own threads first and then asks the app which of them are armed.
   * The three controls are the ones a user needs when the world changes: hold a
   * wake while the other side is closed longer than expected, release it again, or
   * stop waiting altogether.
   */
  interface Props {
    assistant: Assistant
    /** Opens one of the assistant's threads in the conversation. */
    onOpenThread: (thread: Thread) => void
  }

  let { assistant, onOpenThread }: Props = $props()

  let folded = $state(false)
  /** The wake awaiting confirmation before it is stopped. */
  let cancelling = $state<{ id: string; title: string; note: string } | null>(null)
  let busyId = $state<string | null>(null)

  /** The assistant's threads, which is where its wakes can live at all. */
  const threads = $derived(
    scopeState.allScopeThreads.filter((thread) => thread.assistantId === assistant.id)
  )

  /** The thread behind a wake, or null once it was deleted. */
  function threadFor(threadId: string): Thread | null {
    return threads.find((thread) => thread.id === threadId) ?? null
  }

  const wakes = $derived(followUpsState.forThreads(threads.map((thread) => thread.id)))

  /** How long until a wake fires, read from the app's shared ticking clock. */
  function untilLabel(dueAt: number): string {
    const minutes = Math.max(0, Math.round((dueAt - relativeTimeClock.now) / 60_000))
    if (minutes < 1) return 'due now'
    if (minutes < 60) return `in ${minutes} min`
    const hours = Math.round(minutes / 60)
    if (hours < 48) return `in ${hours} h`
    return `in ${Math.round(hours / 24)} d`
  }

  async function control(id: string, action: 'pause' | 'resume' | 'cancel'): Promise<void> {
    busyId = id
    try {
      await followUpsState.update(id, action)
    } catch (error) {
      reportError(
        error,
        action === 'cancel' ? 'Could not stop the wake' : 'Could not hold the wake'
      )
    } finally {
      busyId = null
    }
  }

  async function confirmCancel(): Promise<void> {
    const pending = cancelling
    if (!pending) return
    await control(pending.id, 'cancel')
    cancelling = null
  }
</script>

{#if wakes.length > 0}
  <div class="flex flex-col gap-2 border border-border bg-surface p-2.5">
    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        aria-expanded={!folded}
        title={folded ? 'Expand the scheduled wakes' : 'Fold the scheduled wakes'}
        onclick={() => (folded = !folded)}
      >
        <CioForward
          size={12}
          strokeWidth={1.8}
          class="shrink-0 text-dimmed transition-transform duration-150 {folded ? '' : 'rotate-90'}"
        />
        <h2 class="min-w-0 flex-1 truncate text-[0.875rem] font-semibold text-foreground">
          Scheduled wakes
        </h2>
        <span class="shrink-0 text-[0.625rem] text-dimmed">
          {wakes.length}
          {wakes.length === 1 ? 'wake' : 'wakes'}
        </span>
      </button>
    </div>
    {#if !folded}
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        A thread wakes itself at the time it agreed with you, so it can pick the work up again
        without you watching anything. Hold one while the other side is away longer, or stop it when
        the answer already arrived.
      </p>
      <ul class="flex flex-col">
        {#each wakes as wake (wake.id)}
          {@const thread = threadFor(wake.threadId)}
          {@const title = thread?.title ?? wake.note}
          <li
            class="flex flex-col gap-1 border-t border-border py-2 first:border-t-0"
            data-follow-up-row={wake.id}
          >
            <div class="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-1.5 text-left transition-colors hover:text-foreground"
                title="Open {title}"
                aria-label="Open the thread that wakes: {title}"
                onclick={() => {
                  if (thread) onOpenThread(thread)
                }}
              >
                <CioClock
                  size={11}
                  class="shrink-0 {wake.paused ? 'text-dimmed' : 'text-info'}"
                  aria-hidden="true"
                />
                <span class="min-w-0 truncate text-[0.75rem] text-foreground">{title}</span>
              </button>
              {#if wake.paused}
                <StatusPill tone="warning" title="This wake is on hold">Held</StatusPill>
              {/if}
              <span class="shrink-0 whitespace-nowrap text-[0.625rem] text-muted">
                {formatDateTimeWithWeekday(wake.dueAt)}
              </span>
              <span class="shrink-0 whitespace-nowrap text-[0.625rem] text-dimmed">
                {wake.paused ? 'on hold' : untilLabel(wake.dueAt)}
              </span>
              {#if wake.paused}
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                  title="Resume this wake so it fires at its time again"
                  aria-label="Resume the scheduled wake for {title}"
                  disabled={busyId === wake.id}
                  onclick={() => void control(wake.id, 'resume')}
                >
                  <CioPlay size={12} strokeWidth={1.8} />
                </button>
              {:else}
                <button
                  type="button"
                  class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
                  title="Hold this wake so it does not fire until you resume it"
                  aria-label="Pause the scheduled wake for {title}"
                  disabled={busyId === wake.id}
                  onclick={() => void control(wake.id, 'pause')}
                >
                  <CioPause size={12} strokeWidth={1.8} />
                </button>
              {/if}
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                title="Stop this wake and remove it from the schedule"
                aria-label="Stop the scheduled wake for {title}"
                disabled={busyId === wake.id}
                onclick={() => (cancelling = { id: wake.id, title, note: wake.note })}
              >
                <CioStop size={12} strokeWidth={1.8} />
              </button>
            </div>
            <p class="min-w-0 truncate pl-[1.0625rem] text-[0.625rem] text-muted" title={wake.note}>
              {wake.note}
            </p>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<ConfirmDialog
  open={cancelling !== null}
  title="Stop this wake?"
  confirmLabel="Stop the wake"
  variant="danger"
  busy={cancelling !== null && busyId === cancelling.id}
  onCancel={() => (cancelling = null)}
  onConfirm={confirmCancel}
>
  <p>
    {cancelling?.title ?? 'This thread'} will not wake itself at its scheduled time. You can ask the agent
    to schedule another one whenever you want.
  </p>
  <p class="mt-2 text-muted">{cancelling?.note ?? ''}</p>
</ConfirmDialog>
