<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import type { PrMergeMethod, PullRequestSummary } from '$shared/types'

  interface Props {
    number: number
    summary: PullRequestSummary
    method: PrMergeMethod
    /** True when the head's checks are currently failing. */
    checksFailure: boolean
    /** Unique per mounted reader, so the dialog's field ids never collide. */
    mergeFieldSuffix: string
    mergeOpen: boolean
    closeOpen: boolean
    resolveOpen: boolean
    commitTitle: string
    commitMessage: string
    onMerge: () => void
    onResolveLocally: () => void
    onClosePullRequest: () => void
  }

  let {
    number,
    summary,
    method,
    checksFailure,
    mergeFieldSuffix,
    mergeOpen = $bindable(),
    closeOpen = $bindable(),
    resolveOpen = $bindable(),
    commitTitle = $bindable(),
    commitMessage = $bindable(),
    onMerge,
    onResolveLocally,
    onClosePullRequest
  }: Props = $props()
</script>

<AlertDialog.Root open={mergeOpen} onOpenChange={(value) => (mergeOpen = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Merge pull request #{number}?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        <strong class="text-foreground">{summary.title}</strong> will be merged into
        <strong class="text-foreground">{summary.baseRef}</strong> using the
        <strong class="text-foreground">{method}</strong> method.
        {#if checksFailure}
          Checks are currently <strong class="text-danger">failing</strong> on this branch.
        {/if}
        This runs on GitHub and cannot be undone from here.
      </AlertDialog.Description>

      {#if method === 'rebase'}
        <p
          class="mt-3 rounded-lg border border-border bg-surface px-3 py-2 text-[0.625rem] leading-relaxed text-dimmed"
        >
          Rebase preserves the original commits, so there's no custom commit message to add.
        </p>
      {:else}
        <div class="mt-3 space-y-2">
          <div>
            <label
              class="mb-1 block text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
              for="merge-commit-title-{mergeFieldSuffix}"
            >
              Commit title
            </label>
            <input
              id="merge-commit-title-{mergeFieldSuffix}"
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
              for="merge-commit-message-{mergeFieldSuffix}"
            >
              Commit message
            </label>
            <textarea
              id="merge-commit-message-{mergeFieldSuffix}"
              class="min-h-16 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder={method === 'merge'
                ? 'Describe the merge (optional)'
                : 'Commit message for the squashed changes'}
              bind:value={commitMessage}></textarea>
          </div>
        </div>
      {/if}
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
          onclick={onMerge}
        >
          Merge
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<AlertDialog.Root open={resolveOpen} onOpenChange={(value) => (resolveOpen = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Resolve conflicts for PR #{number}?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        This checks out the <strong class="text-foreground">{summary.headRef}</strong> branch
        locally as <code class="font-mono">pr-{number}</code>, merges
        <strong class="text-foreground">{summary.baseRef}</strong> into it, and switches the Git panel
        to the changes tab. You'll resolve each conflicted file in your editor, then commit and push to
        update the pull request.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-warning px-3 text-xs font-medium text-on-primary hover:bg-warning/90"
          onclick={() => {
            resolveOpen = false
            onResolveLocally()
          }}
        >
          Resolve locally
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>

<AlertDialog.Root open={closeOpen} onOpenChange={(value) => (closeOpen = value)}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Close pull request #{number}?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        <strong class="text-foreground">{summary.title}</strong> will be closed without merging. You can
        reopen it later from this view.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:bg-danger/90"
          onclick={onClosePullRequest}
        >
          Close
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
