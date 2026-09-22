<script lang="ts">
  import { TriangleAlert } from '@lucide/svelte'

  /**
   * Canonical, non-dismissible notice for a panel whose content belongs to
   * another scope than the open thread's.
   *
   * A few panels are deliberately project-scoped: they survive a thread switch
   * instead of remounting, so switching to a thread in a different worktree
   * leaves them rendering the previous scope root (its file tree) while the
   * mismatch lasts. Those panels render this toolbar so the mismatch is never
   * silent.
   *
   * The wording lives here and only here: every host shows the same sentence,
   * and none of them can hide it while the mismatch lasts.
   */
  interface Props {
    /** Whether the panel's content was produced for another scope root. */
    stale: boolean
  }

  let { stale }: Props = $props()
</script>

{#if stale}
  <div
    class="flex w-full shrink-0 items-center gap-1.5 border-b border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning"
    role="status"
    data-panel-scope-stale="true"
  >
    <TriangleAlert size={12} class="shrink-0" aria-hidden="true" />
    <span class="min-w-0 truncate"> Panel info is stale, toggle for latest info </span>
  </div>
{/if}
