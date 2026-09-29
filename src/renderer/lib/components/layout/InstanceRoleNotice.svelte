<script lang="ts">
  import { ArrowLeftRight, Info } from '@lucide/svelte'

  /**
   * The standing "running in another instance" notice.
   *
   * One backend per config root: exactly one process owns the scheduled work,
   * and a second process is only a window into it. That is a standing condition,
   * not an event, so this is a non-dismissible bar (like `StalePanelNotice`)
   * rather than a toast   it disappears by itself the moment this instance is
   * promoted after the owner exits, or the user transfers control here.
   */
  interface Props {
    /** Process id of the instance that owns the schedule, when it is known. */
    ownerPid: number
    /** Ask the owner to bring its window forward. */
    onOpenOwner: () => void
    /** Take ownership of scheduled work over from the current owner. */
    onTakeOver: () => void
    /** Quit this instance; the owner is untouched. */
    onQuit: () => void
  }

  let { ownerPid, onOpenOwner, onTakeOver, onQuit }: Props = $props()
</script>

<div
  class="flex w-full shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-info/40 bg-info/10 px-3 py-1.5 text-xs text-info"
  role="status"
  data-instance-role="secondary"
>
  <Info size={12} class="shrink-0" aria-hidden="true" />
  <span class="min-w-0 flex-1 truncate">
    CodeInOven is running in another instance{ownerPid > 0 ? ` (pid ${ownerPid})` : ''}. Scheduled
    work continues there.
  </span>
  <button
    type="button"
    class="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 font-medium transition-colors hover:bg-info/15"
    title="Take over scheduled work in this window so it runs here instead"
    onclick={onTakeOver}
  >
    <ArrowLeftRight size={12} aria-hidden="true" />
    Make this the main instance
  </button>
  <button
    type="button"
    class="shrink-0 whitespace-nowrap rounded-md px-2 py-1 font-medium transition-colors hover:bg-info/15"
    title="Bring the other CodeInOven window to the front"
    onclick={onOpenOwner}
  >
    Open running instance
  </button>
  <button
    type="button"
    class="shrink-0 whitespace-nowrap rounded-md px-2 py-1 font-medium transition-colors hover:bg-info/15"
    title="Quit this CodeInOven window"
    onclick={onQuit}
  >
    Quit this instance
  </button>
</div>
