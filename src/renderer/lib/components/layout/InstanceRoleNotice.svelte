<script lang="ts">
  import { ArrowLeftRight, Info } from '@lucide/svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import NoticeDismissButton from '../ui/NoticeDismissButton.svelte'

  /**
   * The standing "running in another instance" notice.
   *
   * One backend per config root: exactly one process owns the scheduled work,
   * and a second process is only a window into it. That is a standing condition,
   * not an event, so this is a persistent bar rather than a toast: it is still
   * true the moment this instance is promoted after the owner exits, or the user
   * transfers control here.
   *
   * The bar is dismissible, and dismissing it hides only the bar. The host keeps
   * passing `ownerPid` from the live instance role, so a closed bar does not make
   * this window the owner or stop the other one owning the schedule. The
   * dismissal is keyed to the owner pid, so a different instance taking over, or
   * a new owner appearing, raises the bar again.
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

  const noticeId = 'instanceRole:secondary'
  const noticeCondition = $derived(`owner:${ownerPid}`)
</script>

{#if !noticeDismissals.isDismissed(noticeId, noticeCondition)}
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
    <NoticeDismissButton
      id={noticeId}
      condition={noticeCondition}
      title="Dismiss the other instance notice"
      size="sm"
    />
  </div>
{/if}
