<script lang="ts">
  import { draggablePopover } from '$lib/draggable-popover.svelte'
  import CommentBubble from './CommentBubble.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'

  interface Props {
    /** Horizontal center of the anchor bubble, viewport coordinates. */
    x: number
    /** Top edge of the anchor bubble, viewport coordinates. */
    y: number
    initialComment: string
    targetId: string
    scope: SpeechScope
    onDraftChange: (comment: string) => void
    onDone: (comment: string) => void
    /** Detach the entire selection (highlight, bubble, and comment) from the chat. */
    onRemove: () => void
    onClose: () => void
  }

  let { x, y, initialComment, targetId, scope, onDraftChange, onDone, onRemove, onClose }: Props =
    $props()

  const POPOVER_WIDTH = 400

  let preferredLeft = $derived(x - POPOVER_WIDTH / 2)
  let preferredTop = $derived(y + 41)
</script>

<button
  type="button"
  class="fixed inset-0 z-40 cursor-default"
  aria-label="Close selection comment"
  onclick={onClose}
></button>

<div
  class="fixed z-50"
  style:width={`${POPOVER_WIDTH}px`}
  {@attach draggablePopover({ x: preferredLeft, y: preferredTop })}
>
  <CommentBubble
    title="Comment on selection"
    dragHandleTitle="Move selection comment"
    {initialComment}
    {targetId}
    {scope}
    {onDraftChange}
    {onDone}
    {onRemove}
    {onClose}
  />
</div>
