<script lang="ts">
  import { X } from '@lucide/svelte'
  import { draggablePopover } from '$lib/draggable-popover.svelte'
  import PopoverDragHandle from '../ui/PopoverDragHandle.svelte'
  import AnnotationCommentForm from './AnnotationCommentForm.svelte'
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
  class="fixed z-50 rounded-xl border border-border bg-surface p-3 shadow-lg"
  style:width={`${POPOVER_WIDTH}px`}
  role="dialog"
  aria-label="Comment on selection"
  data-voice-trigger-root
  {@attach draggablePopover({ x: preferredLeft, y: preferredTop })}
>
  <div class="mb-2 flex items-center justify-between gap-2">
    <span class="flex min-w-0 items-center gap-1">
      <PopoverDragHandle title="Move selection comment" />
      <span class="truncate text-xs font-semibold text-foreground">Comment on selection</span>
    </span>
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Close comment"
      aria-label="Close comment"
      onclick={onClose}
    >
      <X size={13} />
    </button>
  </div>
  <AnnotationCommentForm
    {initialComment}
    {targetId}
    {scope}
    {onDraftChange}
    {onDone}
    {onRemove}
    {onClose}
  />
</div>
