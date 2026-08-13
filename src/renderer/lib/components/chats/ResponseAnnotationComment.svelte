<script lang="ts">
  import { Check, Trash2, X } from '@lucide/svelte'
  import { onMount } from 'svelte'

  interface Props {
    /** Horizontal center of the anchor bubble, viewport coordinates. */
    x: number
    /** Top edge of the anchor bubble, viewport coordinates. */
    y: number
    initialComment: string
    onDone: (comment: string) => void
    onRemoveComment: () => void
    onClose: () => void
  }

  let { x, y, initialComment, onDone, onRemoveComment, onClose }: Props = $props()

  const POPOVER_WIDTH = 400
  const POPOVER_HEIGHT = 240

  // The popover is remounted fresh each time it opens, so the props are only
  // read at creation and never change during the popover's lifetime.
  // svelte-ignore state_referenced_locally
  let comment = $state(initialComment)
  let textarea: HTMLTextAreaElement

  let left = $derived(
    Math.max(12, Math.min(x - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 12))
  )
  let top = $derived(Math.max(12, Math.min(y + 41, window.innerHeight - POPOVER_HEIGHT - 12)))

  onMount(() => {
    textarea.focus()
    textarea.setSelectionRange(comment.length, comment.length)
  })

  function submit(): void {
    onDone(comment)
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
  style:left={`${left}px`}
  style:top={`${top}px`}
  style:width={`${POPOVER_WIDTH}px`}
  role="dialog"
  aria-label="Comment on selection"
>
  <div class="mb-2 flex items-center justify-between gap-2">
    <span class="text-xs font-semibold text-foreground">Comment on selection</span>
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
    bind:value={comment}
    class="h-20 w-full resize-none rounded-lg border border-border bg-elevated px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-dimmed"
    placeholder="Add a comment for the agent…"
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
