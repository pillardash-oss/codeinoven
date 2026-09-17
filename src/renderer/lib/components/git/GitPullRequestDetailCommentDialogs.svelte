<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type { ConversationEntry } from './git-pull-request-detail-format'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    number: number
    /** The comment a Delete confirmation is open for, or null. */
    entry: ConversationEntry | null
    onClose: () => void
    /** Surface a one-line confirmation in the reader's header. */
    onNotice: (message: string) => void
    /** Reload the bundle after the comment is gone. */
    onRefresh: () => Promise<void>
  }

  let { projectId, identity, number, entry, onClose, onNotice, onRefresh }: Props = $props()

  /** The Delete confirmation's panel, for owning its initial focus. */
  let deletePanel = $state<HTMLDivElement | null>(null)

  /**
   * Own the confirmation's initial focus instead of bits-ui's default of focusing
   * the panel itself. There is no field to fill, so focus lands on the primary
   * action, which is what a modal without an input is supposed to do.
   */
  function focusDeleteDialog(event: Event): void {
    event.preventDefault()
    if (!deletePanel) return
    findPanelPrimaryAction(deletePanel)?.focus({ preventScroll: true })
  }

  async function deleteEntry(): Promise<void> {
    const target = entry
    if (!target || target.commentId === null) return
    const commentId = target.commentId
    onClose()
    const deleted = await gitState.deletePrComment(
      projectId,
      identity.owner,
      identity.repo,
      number,
      target.commentKind,
      commentId
    )
    if (!deleted) return
    onNotice('Comment deleted')
    await onRefresh()
  }
</script>

<AlertDialog.Root
  open={entry !== null}
  onOpenChange={(value) => {
    if (!value) onClose()
  }}
>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-90 bg-black/40" />
    <AlertDialog.Content
      bind:ref={deletePanel}
      onOpenAutoFocus={focusDeleteDialog}
      class="fixed left-1/2 top-1/2 z-90 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Delete this comment?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Your comment by
        <strong class="text-foreground">{entry?.author ?? ''}</strong>
        will be removed from pull request #{number}. This runs on GitHub and cannot be undone from
        here.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2" data-modal-footer>
        <AlertDialog.Cancel
          data-modal-dismiss
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-xs text-foreground hover:bg-elevated"
        >
          Cancel
        </AlertDialog.Cancel>
        <AlertDialog.Action
          data-modal-primary
          class="h-8 cursor-pointer rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={() => void deleteEntry()}
        >
          Delete
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
