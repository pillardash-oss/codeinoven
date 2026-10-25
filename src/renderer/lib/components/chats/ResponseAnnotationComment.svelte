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
    /**
     * What is being commented on, so the bubble names it correctly.
     *
     * Every annotation in the app is written in the same popover; only the
     * wording says what the comment is about. A response selection, a mark drawn
     * on a picture and an element picked inside an inline SVG all open this
     * component, so the caller supplies the words rather than the component
     * assuming a selection.
     */
    title?: string
    dragHandleTitle?: string
    closeLabel?: string
    removeTitle?: string
    /** The read-only chat pair on the comment field, when the caller has a
     *  reference (an element, a mark, a moment) the user can ask about. */
    onExplain?: () => void
    onQuickChat?: () => void
    /** What the pair is about, so both titles name it. */
    chatSubject?: string
  }

  let {
    x,
    y,
    initialComment,
    targetId,
    scope,
    onDraftChange,
    onDone,
    onRemove,
    onClose,
    title = 'Comment on selection',
    dragHandleTitle = 'Move selection comment',
    closeLabel = 'Close selection comment',
    removeTitle,
    onExplain,
    onQuickChat,
    chatSubject
  }: Props = $props()

  const POPOVER_WIDTH = 400

  let preferredLeft = $derived(x - POPOVER_WIDTH / 2)
  let preferredTop = $derived(y + 41)
</script>

<button
  type="button"
  class="fixed inset-0 z-40 cursor-default"
  aria-label={closeLabel}
  onclick={onClose}
></button>

<div
  class="fixed z-50"
  style:width={`${POPOVER_WIDTH}px`}
  {@attach draggablePopover({ x: preferredLeft, y: preferredTop })}
>
  <CommentBubble
    {title}
    {dragHandleTitle}
    {initialComment}
    {targetId}
    {scope}
    {onDraftChange}
    {onDone}
    {onRemove}
    {onClose}
    {removeTitle}
    {onExplain}
    {onQuickChat}
    {chatSubject}
  />
</div>
