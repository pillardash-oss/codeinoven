<script lang="ts">
  import { X } from '@lucide/svelte'
  import AnnotationCommentForm from '../chats/AnnotationCommentForm.svelte'
  import type { ResponseReferenceAnchor } from '$lib/stores/response-references.svelte'

  /**
   * The comment editor for a picked design element.
   *
   * The browser page is a native view composited above every DOM surface, so a
   * comment box cannot float over the element the way the conversation's bubble
   * comment does. It docks under the page instead, and it is the app's own
   * editor (`AnnotationCommentForm`): the application's colours, dictation, a
   * resizable field, and the same shortcuts as every other comment in the app.
   * The element it belongs to stays outlined in the page while it is open.
   */
  interface Props {
    reference: ResponseReferenceAnchor
    /** One-based position in the composer, matching the number on the page pin. */
    number: number
    projectId: string
    threadId: string
    onDraftChange: (comment: string) => void
    onDone: (comment: string) => void
    onRemove: () => void
    onClose: () => void
  }

  let { reference, number, projectId, threadId, onDraftChange, onDone, onRemove, onClose }: Props =
    $props()

  /** The element's short name, which is the first line of its descriptor
   *  (`Design element: h1#title.lede`). */
  let elementName = $derived(
    (reference.text.split('\n')[0] ?? '').replace(/^Design element:\s*/u, '') || reference.label
  )
</script>

<div
  class="shrink-0 border-t border-border bg-surface px-3 py-2.5"
  role="dialog"
  aria-label={`Comment on ${elementName}`}
  data-voice-trigger-root
>
  <div class="mb-2 flex items-center justify-between gap-2">
    <span class="flex min-w-0 items-center gap-2">
      <span
        class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent/15 text-[0.625rem] font-semibold text-accent tabular-nums"
        aria-hidden="true"
      >
        {number}
      </span>
      <span class="truncate text-xs font-semibold text-foreground" title={reference.text}>
        Comment on {elementName}
      </span>
    </span>
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Close comment"
      aria-label="Close comment"
      onclick={onClose}
    >
      <X size={13} />
    </button>
  </div>
  <AnnotationCommentForm
    initialComment={reference.comment ?? ''}
    targetId={`design-comment-${threadId}-${reference.id}`}
    scope={{ kind: 'project', projectId }}
    placeholder="Describe the change for the agent…"
    fieldClass="h-24 min-h-20"
    removeTitle="Remove this element comment from the chat"
    doneTitle="Done: attach this comment to the element"
    {onDraftChange}
    {onDone}
    {onRemove}
    {onClose}
  />
</div>
