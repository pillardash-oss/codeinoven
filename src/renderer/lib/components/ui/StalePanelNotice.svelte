<script lang="ts">
  import type { Snippet } from 'svelte'
  import { TriangleAlert } from '@lucide/svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import NoticeDismissButton from './NoticeDismissButton.svelte'

  /**
   * Canonical notice for a panel whose content belongs to another scope than the
   * open thread's.
   *
   * A few panels are deliberately project-scoped: they survive a thread switch
   * instead of remounting, so switching to a thread in a different worktree
   * leaves them showing the previous scope root (its file tree) or a shell
   * still sitting in it (a terminal, an action run). Those panels render this
   * toolbar so the mismatch is never silent.
   *
   * One panel is stale in a second way: the coordinator's canvas can fall behind
   * the screens it frames. That is not a scope mismatch but it is the same
   * warning with the same remedy shape, so it borrows this toolbar and passes the
   * sentence its own reading produced.
   *
   * Every sentence lives here and only here, so no host can invent its own copy.
   * A host that can remedy the mismatch (restarting a shell into the open scope)
   * passes an `action` snippet; a host that cannot shows the sentence alone.
   *
   * The bar is dismissible, and dismissing it is purely a display decision: the
   * host's `stale` prop is untouched, so a panel the user closed this toolbar on
   * is still stale and its content still belongs to the other scope. The
   * dismissal is keyed to the sentence, so the same panel going stale for a
   * different reason says so again instead of hiding under the old dismissal.
   */
  type StaleReason = 'mount' | 'run' | 'canvas'

  interface Props {
    /** Whether the panel's content belongs to another scope than the open thread's. */
    stale: boolean
    /** Which sentence to show: `mount` for content read from a scope root,
     *  `run` for a live process started in another scope, `canvas` for a panel
     *  whose own artifact has fallen behind and carries its own sentence. */
    reason?: StaleReason
    /** The sentence to show instead of the reason's own, for a panel whose
     *  artifact reports what is behind in its own words. */
    message?: string
    /** Whether the sentence may wrap instead of being cut to one line. A host
     *  whose sentence reports what is behind, rather than naming a state, has more
     *  to say than one line of a narrow panel holds. */
    wrap?: boolean
    /** Optional remedy control, rendered at the trailing edge of the toolbar. */
    action?: Snippet
  }

  const STALE_MESSAGES: Record<StaleReason, string> = {
    mount: 'Panel info is stale, toggle panel to see info related to this thread',
    run: 'A live run here was started in another scope',
    canvas: 'This panel is out of date'
  }

  let { stale, reason = 'mount', message, wrap = false, action }: Props = $props()
  let sentence = $derived(message ?? STALE_MESSAGES[reason])

  /** Keyed to the sentence, which is also what identifies the reason to the user. */
  const noticeId = $derived(`stalePanel:${reason}`)
  const noticeCondition = $derived(sentence)
</script>

{#if stale && !noticeDismissals.isDismissed(noticeId, noticeCondition)}
  <div
    class="flex w-full shrink-0 items-center gap-1.5 border-b border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning"
    role="status"
    data-panel-scope-stale={reason}
  >
    <TriangleAlert size={12} class="shrink-0" aria-hidden="true" />
    <span class={wrap ? 'min-w-0' : 'min-w-0 truncate'} title={sentence}>{sentence}</span>
    {#if action}
      {@render action()}
    {/if}
    <NoticeDismissButton
      id={noticeId}
      condition={noticeCondition}
      title="Dismiss the stale panel notice"
      size="sm"
    />
  </div>
{/if}
