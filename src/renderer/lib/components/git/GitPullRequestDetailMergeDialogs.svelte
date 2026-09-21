<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import type { PullRequestSummary } from '$shared/types'

  /**
   * The reader's close and conflict-resolution confirmations.
   *
   * The merge confirmation is deliberately not here. It holds parameters worth
   * reviewing before they run (the method, the commit title, the message a squash
   * commit will carry) and the list's row menu asks the same question, so it lives
   * in `PrMergeConfirmDialog.svelte` and both surfaces mount that one.
   */
  interface Props {
    number: number
    summary: PullRequestSummary
    closeOpen: boolean
    resolveOpen: boolean
    onResolveLocally: () => void
    onClosePullRequest: () => void
  }

  let {
    number,
    summary,
    closeOpen = $bindable(),
    resolveOpen = $bindable(),
    onResolveLocally,
    onClosePullRequest
  }: Props = $props()
</script>

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
