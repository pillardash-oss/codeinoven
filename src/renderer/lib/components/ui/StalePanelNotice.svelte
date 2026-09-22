<script lang="ts">
  import type { Snippet } from 'svelte'
  import { TriangleAlert } from '@lucide/svelte'

  /**
   * Canonical, non-dismissible notice for a panel whose content belongs to
   * another scope than the open thread's.
   *
   * A few panels are deliberately project-scoped: they survive a thread switch
   * instead of remounting, so switching to a thread in a different worktree
   * leaves them showing the previous scope root (its file tree) or a shell
   * still sitting in it (a terminal, an action run). Those panels render this
   * toolbar so the mismatch is never silent.
   *
   * Every sentence lives here and only here, so no host can invent its own
   * copy or hide the notice while the mismatch lasts. A host that can remedy
   * the mismatch (restarting a shell into the open scope) passes an `action`
   * snippet; a host that cannot shows the sentence alone.
   */
  type StaleReason = 'mount' | 'run'

  interface Props {
    /** Whether the panel's content belongs to another scope than the open thread's. */
    stale: boolean
    /** Which sentence to show: `mount` for content read from a scope root,
     *  `run` for a live process started in another scope. */
    reason?: StaleReason
    /** Optional remedy control, rendered at the trailing edge of the toolbar. */
    action?: Snippet
  }

  const STALE_MESSAGES: Record<StaleReason, string> = {
    mount: 'Panel info is stale, toggle panel to see info related to this thread',
    run: 'A live run here was started in another scope'
  }

  let { stale, reason = 'mount', action }: Props = $props()
</script>

{#if stale}
  <div
    class="flex w-full shrink-0 items-center gap-1.5 border-b border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning"
    role="status"
    data-panel-scope-stale={reason}
  >
    <TriangleAlert size={12} class="shrink-0" aria-hidden="true" />
    <span class="min-w-0 truncate">{STALE_MESSAGES[reason]}</span>
    {#if action}
      {@render action()}
    {/if}
  </div>
{/if}
