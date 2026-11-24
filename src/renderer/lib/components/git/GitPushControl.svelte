<script lang="ts">
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import CioUpload from '@pdslng/cio-icon/CioUpload.svelte'
  import type { GitPushProgress } from '$shared/types'
  import { pushPercent } from './git-push-progress'

  /**
   * Push, with a stop that slides out of its right edge while a push runs.
   *
   * A push is one unbroken round trip, so the only sign of life a large one gives
   * is git's own percentage: it rides the push button while it lasts, and the stop
   * beside it is there for the push that turns out to be the wrong one. Stop arms
   * on the first click and stops on the second, the way the composer's stop
   * square does, so a stray click on a row full of controls can never kill a push
   * someone is waiting on.
   */
  interface Props {
    /** Commits the last fetch counted as waiting to go out. */
    ahead: number
    /** A push is running in this checkout. */
    busy: boolean
    /** The running push is one the stop control can actually call off. */
    stoppable: boolean
    /** A fetch holds the remote lane, or conflicts have to be resolved first. */
    blocked: boolean
    /** The last stage git reported for the running push, or null before it says one. */
    progress: GitPushProgress | null
    /** What the push will send, or why it is unavailable. */
    title: string
    onPush: () => void
    onStop: () => void | Promise<void>
  }

  let { ahead, busy, stoppable, blocked, progress, title, onPush, onStop }: Props = $props()

  /** The stop belongs on screen only while there is a push it can end. */
  const showsStop = $derived(busy && stoppable)

  /**
   * git's own number, folded across the stages it restarts in, so the button
   * counts up once instead of reaching 100 three times in one push.
   */
  const percent = $derived(progress ? pushPercent(progress) : null)

  /** How long the armed stop waits before it forgets the first click. */
  const ARM_TIMEOUT_MS = 3000

  let armed = $state(false)
  let armTimer: ReturnType<typeof setTimeout> | undefined = undefined

  function disarm(): void {
    clearTimeout(armTimer)
    armed = false
  }

  /**
   * Arm on the first click, stop on the second. The armed state expires on its
   * own, so a stop the user thought better of never sits there waiting to be
   * confirmed by the next click on the row.
   */
  function clickStop(): void {
    if (armed) {
      disarm()
      void onStop()
      return
    }
    armed = true
    armTimer = setTimeout(() => {
      armed = false
    }, ARM_TIMEOUT_MS)
  }

  function clickPush(): void {
    // Starting a push is the start of a new one, never the confirmation of a
    // stop that was armed for the previous one.
    disarm()
    onPush()
  }

  $effect(() => () => {
    clearTimeout(armTimer)
  })
</script>

<div class="flex min-w-0 flex-1 items-stretch">
  <button
    type="button"
    class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1 bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40"
    {title}
    disabled={blocked || busy}
    onclick={clickPush}
  >
    {#if busy}
      <CioSpinner size={11} class="animate-spin" aria-hidden="true" />
    {:else}
      <CioUpload size={11} aria-hidden="true" />
    {/if}
    <span class="min-w-0 truncate tabular-nums">
      {#if busy && percent !== null}
        Push {percent}%
      {:else}
        Push{ahead > 0 ? ` ${String(ahead)}` : ''}
      {/if}
    </span>
  </button>

  <!-- The stop slides out of the push button's right edge and back in when the
       push settles. Width and opacity only, so the row's other controls move
       once rather than the layout jumping when a percentage lands. -->
  <button
    type="button"
    class="push-stop flex h-6 shrink-0 items-center justify-center overflow-hidden text-[0.625rem] font-semibold {armed
      ? 'bg-danger text-on-danger'
      : 'bg-elevated text-muted hover:bg-danger/10 hover:text-danger'}"
    class:is-present={showsStop}
    inert={!showsStop || undefined}
    aria-label={armed ? 'Confirm stop push' : 'Stop push'}
    title={armed ? 'Click again to stop the push' : 'Stop this push'}
    onclick={clickStop}
  >
    <span class="grid h-4 w-4 shrink-0 place-items-center">
      <CioStop size={11} aria-hidden="true" />
    </span>
  </button>
</div>

<style>
  .push-stop {
    width: 0;
    /* A flex item's automatic minimum size would floor the width at the glyph,
       so the collapsed box has to say it may reach zero. */
    min-width: 0;
    opacity: 0;
    pointer-events: none;
    transition:
      width 190ms cubic-bezier(0.215, 0.61, 0.355, 1),
      opacity 140ms ease,
      background-color 140ms ease,
      color 140ms ease;
  }

  .push-stop.is-present {
    width: 1.5rem;
    opacity: 1;
    pointer-events: auto;
  }

  @media (prefers-reduced-motion: reduce) {
    .push-stop {
      transition: none;
    }
  }
</style>
