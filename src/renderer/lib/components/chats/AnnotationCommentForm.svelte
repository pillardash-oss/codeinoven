<script lang="ts">
  import { Check, Trash2 } from '@lucide/svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import { plainTextEditorTarget } from '../../speech/editor-target'
  import { speechController } from '../../speech/speech-controller.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'

  /**
   * The one comment editor the app writes comments in.
   *
   * A comment is written in several places (a quoted response selection, an
   * annotated document passage, a picked design element in the browser), and
   * every one of them needs the same field, the same dictation button, the same
   * shortcuts and the same draft persistence. This is that field, so a comment
   * behaves and looks the same wherever it is opened; the surface around it
   * (a draggable popover, a docked bar) is the caller's business.
   */
  interface Props {
    initialComment: string
    /** Stable id of the field. Dictation and the word-count of a resumed draft
     *  both name one target, so it has to be unique per open editor. */
    targetId: string
    scope: SpeechScope
    /** Persist the in-progress text, so a closed editor or a restart cannot
     *  discard what the user typed. */
    onDraftChange: (comment: string) => void
    onDone: (comment: string) => void
    /** Detach the comment, and the reference it belongs to, from the chat. */
    onRemove: () => void
    onClose: () => void
    /** What the field asks for, which differs by what is being commented on. */
    placeholder?: string
    /** Height classes for the field, so a docked editor can offer more room
     *  than a popover anchored to a bubble. */
    fieldClass?: string
    removeTitle?: string
    doneTitle?: string
  }

  let {
    initialComment,
    targetId,
    scope,
    onDraftChange,
    onDone,
    onRemove,
    onClose,
    placeholder = 'Add a comment for the agent…',
    fieldClass = 'h-20 min-h-20',
    removeTitle = 'Remove this comment and the reference it belongs to',
    doneTitle = 'Done: attach this comment'
  }: Props = $props()

  // The editor is remounted fresh each time it opens, so the initial text is
  // only read at creation and the props never change during its lifetime.
  // svelte-ignore state_referenced_locally
  let comment = $state(initialComment)
  // svelte-ignore state_referenced_locally
  const initialCursorPosition = initialComment.length
  let textarea: HTMLTextAreaElement | null = null
  const speechTarget = $derived(plainTextEditorTarget({ id: targetId, element: () => textarea }))

  function focusTextarea(element: HTMLTextAreaElement): void {
    element.focus()
    element.setSelectionRange(initialCursorPosition, initialCursorPosition)
  }

  function submit(): void {
    // Dictation learns from the send, so the transcript and the pair that ends
    // up attached stay in step.
    speechController.observeSent(targetId, comment)
    onDone(comment)
  }

  function updateDraft(event: Event & { currentTarget: HTMLTextAreaElement }): void {
    comment = event.currentTarget.value
    onDraftChange(comment)
  }

  function onKeydown(event: KeyboardEvent): void {
    if (keymapState.matches('chat-annotation-close', event)) {
      event.preventDefault()
      onClose()
    }
    if (keymapState.matches('chat-annotation-comment', event)) {
      event.preventDefault()
      submit()
    }
  }
</script>

<textarea
  bind:this={textarea}
  {@attach focusTextarea}
  value={comment}
  class="{fieldClass} w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-dimmed"
  {placeholder}
  oninput={updateDraft}
  onkeydown={onKeydown}></textarea>
<div class="mt-2 flex items-center justify-between gap-1.5">
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:pointer-events-none disabled:opacity-40"
    title={removeTitle}
    disabled={!comment.trim()}
    onclick={onRemove}
  >
    <Trash2 size={12} />
    Remove
  </button>
  <VoiceInputButton {targetId} getTarget={() => speechTarget} {scope} triggerPriority={6} />
  <button
    type="button"
    class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
    title={doneTitle}
    onclick={submit}
  >
    <Check size={12} />
    Done
  </button>
</div>
