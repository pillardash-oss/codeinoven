<script lang="ts">
  import { githubDisplayLogin } from '$lib/format/github-login'
  import { gitState } from '$lib/stores/git.svelte'
  import type { ConversationEntry } from './git-pull-request-detail-format'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

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

<ConfirmDialog
  open={entry !== null}
  title="Delete this comment?"
  onCancel={onClose}
  onConfirm={() => void deleteEntry()}
  confirmLabel="Delete"
>
  <p>
    Your comment by
    <strong class="text-foreground">{githubDisplayLogin(entry?.author)}</strong>
    will be removed from pull request #{number}. This runs on GitHub and cannot be undone from here.
  </p>
</ConfirmDialog>
