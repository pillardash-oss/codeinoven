<script lang="ts">
  import type { PrMergeMethod, PullRequestSummary } from '$shared/types'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'

  /**
   * The merge confirmation, shared by the detail reader and the list's row menu.
   *
   * It lives apart from the reader because a merge is the one pull request action
   * with parameters worth reviewing before it runs: the method, the commit title,
   * and the message the squash commit will carry. Two surfaces asking that
   * question have to ask it the same way, so there is one dialog and both mount
   * it, and it renders through the shared `ConfirmDialog` so a merge asks its
   * question with the same chrome as every other confirmation in the app.
   *
   * The title and message stay with the caller rather than being owned here, which
   * is what lets the reader keep seeding them from the pull request's own body and
   * the list seed them from nothing.
   */
  interface Props {
    open: boolean
    number: number
    summary: PullRequestSummary
    method: PrMergeMethod
    /** True when the head's checks are currently failing. */
    checksFailure?: boolean
    /** Unique per mounted surface, so the dialog's field ids never collide. */
    fieldSuffix: string
    /** True while the merge runs, so the confirm reports progress instead of repeating. */
    busy?: boolean
    commitTitle: string
    commitMessage: string
    onConfirm: () => void
  }

  let {
    open = $bindable(),
    number,
    summary,
    method,
    checksFailure = false,
    fieldSuffix,
    busy = false,
    commitTitle = $bindable(),
    commitMessage = $bindable(),
    onConfirm
  }: Props = $props()
</script>

<ConfirmDialog
  {open}
  title={`Merge pull request #${number}?`}
  onCancel={() => (open = false)}
  {onConfirm}
  confirmLabel="Merge"
  {busy}
  variant="primary"
>
  <p>
    <strong class="text-foreground">{summary.title}</strong>
    will be merged into
    <strong class="text-foreground">{summary.baseRef}</strong>
    using the
    <strong class="text-foreground">{method}</strong>
    method.
    {#if checksFailure}
      Checks are currently <strong class="text-danger">failing</strong> on this branch.
    {/if}
    This runs on GitHub and cannot be undone from here.
  </p>

  {#if method === 'rebase'}
    <p
      class="rounded-lg border border-border bg-surface px-3 py-2 text-[0.625rem] leading-relaxed text-dimmed"
    >
      Rebase preserves the original commits, so there's no custom commit message to add.
    </p>
  {:else}
    <div class="space-y-2">
      <div>
        <label
          class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
          for="merge-commit-title-{fieldSuffix}"
        >
          Commit title
        </label>
        <input
          id="merge-commit-title-{fieldSuffix}"
          class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder={method === 'merge'
            ? `Merge pull request #${number} from ${summary.headRef}`
            : 'Title of the squashed commit'}
          bind:value={commitTitle}
        />
      </div>
      <div>
        <label
          class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
          for="merge-commit-message-{fieldSuffix}"
        >
          Commit message
        </label>
        <textarea
          id="merge-commit-message-{fieldSuffix}"
          class="min-h-16 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder={method === 'merge'
            ? 'Describe the merge (optional)'
            : 'Commit message for the squashed changes'}
          bind:value={commitMessage}></textarea>
      </div>
    </div>
  {/if}
</ConfirmDialog>
