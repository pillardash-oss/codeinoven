<script lang="ts">
  import { Check, Trash2, X } from '@lucide/svelte'
  import { draggablePopover } from '$lib/draggable-popover.svelte'
  import PopoverDragHandle from '../ui/PopoverDragHandle.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import { plainTextEditorTarget } from '../../speech/editor-target'
  import { speechController } from '../../speech/speech-controller.svelte'
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
    onRemoveComment: () => void
    onClose: () => void
  }

  let {
    x,
    y,
    initialComment,
    targetId,
    scope,
    onDraftChange,
    onDone,
    onRemoveComment,
    onClose
  }: Props = $props()

  const POPOVER_WIDTH = 400

  // The popover is remounted fresh each time it opens, so the props are only
  // read at creation and never change during the popover's lifetime.
  // svelte-ignore state_referenced_locally
  let comment = $state(initialComment)
  // svelte-ignore state_referenced_locally
  const initialCursorPosition = initialComment.length
  let textarea: HTMLTextAreaElement | null = null
  const speechTarget = $derived(plainTextEditorTarget({ id: targetId, element: () => textarea }))

  let preferredLeft = $derived(x - POPOVER_WIDTH / 2)
  let preferredTop = $derived(y + 41)

  function focusTextarea(textarea: HTMLTextAreaElement): void {
    textarea.focus()
    textarea.setSelectionRange(initialCursorPosition, initialCursorPosition)
  }

  function submit(): void {
    speechController.observeSent(targetId, comment)
    onDone(comment)
  }

  function updateDraft(event: Event & { currentTarget: HTMLTextAreaElement }): void {
    comment = event.currentTarget.value
    onDraftChange(comment)
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }
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
  <textarea
    bind:this={textarea}
    {@attach focusTextarea}
    value={comment}
    class="h-20 min-h-20 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-dimmed"
    placeholder="Add a comment for the agent…"
    oninput={updateDraft}
    onkeydown={onKeydown}></textarea>
  <div class="mt-2 flex items-center justify-between gap-1.5">
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
      title="Remove the comment from this selection"
      disabled={!comment.trim()}
      onclick={onRemoveComment}
    >
      <Trash2 size={12} />
      Remove
    </button>
    <VoiceInputButton
      {targetId}
      getTarget={() => speechTarget}
      {scope}
      triggerPriority={6}
    />
    <button
      type="button"
      class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Done — attach this comment to the selection"
      onclick={submit}
    >
      <Check size={12} />
      Done
    </button>
  </div>
</div>
