<script lang="ts">
  import { X } from '@lucide/svelte'
  import PopoverDragHandle from '../ui/PopoverDragHandle.svelte'
  import AnnotationCommentForm from './AnnotationCommentForm.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type { Attachment } from 'svelte/attachments'

  /**
   * The one comment bubble the app draws.
   *
   * A comment is written in several places and shown next to whatever it is
   * about: a quoted response selection in the conversation, a picked element in
   * a design the browser is serving. Every one of them is this bubble, so the
   * heading, the drag handle, the close affordance and the field are defined
   * once and a change to any of them lands everywhere at once. The caller owns
   * only what genuinely differs: where the bubble is placed, what the heading
   * says, and what happens when the comment is finished, removed or dismissed.
   *
   * The caller also owns the element the bubble is positioned by, so it wraps
   * this component rather than passing it a placement: a draggable popover in
   * the app window and the same bubble moved into the shared native host that
   * draws app DOM above a browser page position themselves differently.
   */
  interface Props {
    /** The heading. Kept short by the surface: it is truncated, not wrapped. */
    title: string
    /** The accessible name of the dialog, when the heading alone would not
     *  name what is being commented on. */
    ariaLabel?: string
    /** The untruncated heading, for the hover tooltip. */
    titleTooltip?: string
    /** The handle's action, which names what is being moved. */
    dragHandleTitle?: string
    initialComment: string
    /** Stable id of the field, unique per open bubble: dictation and the
     *  resumed-draft word count both name one target. */
    targetId: string
    scope: SpeechScope
    onDraftChange: (comment: string) => void
    onDone: (comment: string) => void
    onRemove: () => void
    onClose: () => void
    attach?: Attachment<HTMLDivElement>
    /** What the field asks for; the caller knows what is being commented on. */
    placeholder?: string
    removeTitle?: string
    doneTitle?: string
  }

  let {
    title,
    ariaLabel = title,
    titleTooltip,
    dragHandleTitle = 'Move comment',
    initialComment,
    targetId,
    scope,
    onDraftChange,
    onDone,
    onRemove,
    onClose,
    attach,
    placeholder,
    removeTitle,
    doneTitle
  }: Props = $props()
</script>

<div
  class="border border-border bg-surface p-3 shadow-lg"
  role="dialog"
  aria-label={ariaLabel}
  data-voice-trigger-root
  data-floating-document
  {@attach attach}
>
  <div class="mb-2 flex items-center justify-between gap-2">
    <span class="flex min-w-0 items-center gap-1">
      <PopoverDragHandle title={dragHandleTitle} />
      <span class="truncate text-xs font-semibold text-foreground" title={titleTooltip ?? title}>
        {title}
      </span>
    </span>
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
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
    {placeholder}
    {removeTitle}
    {doneTitle}
  />
</div>
