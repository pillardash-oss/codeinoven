<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import type { BrowserInspectorRect } from '$shared/ipc-contract'
  import CommentBubble from '../chats/CommentBubble.svelte'
  import { NativeFloatingPanel } from '$lib/native-floating-panel.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { clampPopoverPosition, draggablePopoverOffset } from '$lib/draggable-popover.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'

  interface Props {
    /**
     * Stable name of the native host this panel's bubbles share.
     *
     * One host per surface, created the first time a comment opens and reused
     * after that: the host owns a child window, and a window per comment would
     * pay a whole renderer for every pick.
     */
    hostId: string
    /**
     * The comment on display, or null while none is open.
     *
     * `anchor` is the element's place in the app window's own coordinates, which
     * main resolved from the page's own rectangle and the frame the page sits in.
     */
    comment: {
      referenceId: string
      anchor: BrowserInspectorRect
      /** The element's short name, which the heading names. */
      elementName: string
      /** The comment already written, which a reopened bubble resumes. */
      comment: string
    } | null
    targetId: string
    scope: SpeechScope
    onDraftChange: (referenceId: string, comment: string) => void
    onDone: (referenceId: string, comment: string) => void
    onRemove: (referenceId: string) => void
    onClose: () => void
    /** Ask about the element in a read-only chat, when the caller knows it. */
    onExplain?: () => void
    onQuickChat?: () => void
  }

  let {
    hostId,
    comment,
    targetId,
    scope,
    onDraftChange,
    onDone,
    onRemove,
    onClose,
    onExplain = undefined,
    onQuickChat = undefined
  }: Props = $props()

  /** As wide as the app's other comment bubble, which the heading is sized for. */
  const WIDTH = 400
  /** How far below the element the bubble sits, matching the selection bubble. */
  const GAP = 8
  const VIEWPORT_PADDING = 12

  /**
   * The bubble over a browser page.
   *
   * A browser page is a native `WebContentsView` the compositor paints above
   * every DOM node of the app window, so the app's own comment bubble cannot be
   * drawn over it by z-index. It moves into the shared native host instead, the
   * one `DockableModal` uses for the same reason, which adopts this element into
   * a frameless child window placed exactly where the bubble belongs. The element
   * itself is the app's own `CommentBubble`, so the comment on a design element
   * is the same field, the same dictation button, the same shortcuts and the same
   * draft as a comment on a quoted selection.
   */
  // The host name is the surface's own and never changes while it is mounted,
  // so it is read once, as the host is built.
  // svelte-ignore state_referenced_locally
  const native = new NativeFloatingPanel(`${hostId}-${crypto.randomUUID()}`)
  const nativeArmed = $derived(
    comment !== null && browserVisibility.canUseNativeDock && !native.failed
  )
  const nativeMount: Attachment<HTMLElement> = (element) => native.mount(element)

  /** The bubble's own size, which the host window has to match exactly. */
  let size = $state({ width: WIDTH, height: 0 })
  /**
   * Where the reader dragged the bubble, tagged with the comment it was dragged
   * for.
   *
   * Tagging, rather than resetting on a change, is what keeps a newly opened
   * comment at its own element without an effect: a drag belonging to another
   * comment simply does not apply to this one.
   */
  let dragged = $state<{ referenceId: string; x: number; y: number } | null>(null)

  /** Where the bubble sits: just under its element, until it is dragged. */
  const position = $derived.by(() => {
    if (dragged && dragged.referenceId === comment?.referenceId) {
      return clampPopoverPosition(dragged.x, dragged.y, size, VIEWPORT_PADDING)
    }
    if (!comment) return { x: 0, y: 0 }
    const { anchor } = comment
    return clampPopoverPosition(
      anchor.x + anchor.width / 2 - WIDTH / 2,
      anchor.y + anchor.height + GAP,
      size,
      VIEWPORT_PADDING
    )
  })

  const drag: Attachment<HTMLElement> = draggablePopoverOffset({
    position: () => position,
    onMove: (next) => {
      if (comment) dragged = { referenceId: comment.referenceId, x: next.x, y: next.y }
    },
    viewportPadding: VIEWPORT_PADDING
  })

  // Attach to the rendered bubble, where its handle exists. Rebind measurement
  // to the owning document after the dockable host adopts the live DOM tree.
  const attachBubble: Attachment<HTMLDivElement> = (element) => {
    let measuredWidth = -1
    let measuredHeight = -1
    let observer: ResizeObserver | null = null
    const sync = (): void => {
      const width = element.offsetWidth
      const height = element.offsetHeight
      if (width === measuredWidth && height === measuredHeight) return
      measuredWidth = width
      measuredHeight = height
      size = { width, height }
    }
    const observe = (): void => {
      observer?.disconnect()
      const Observer = element.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver
      observer = new Observer(sync)
      observer.observe(element)
      sync()
    }
    element.addEventListener('native-floating-document-change', observe)
    observe()
    const releaseDrag = drag(element)
    native.focusContent()
    return () => {
      releaseDrag?.()
      observer?.disconnect()
      element.removeEventListener('native-floating-document-change', observe)
    }
  }

  $effect.pre(() => {
    if (!comment) native.restore()
  })

  $effect(() => {
    native.update(nativeArmed, comment !== null, {
      x: position.x,
      y: position.y,
      width: size.width,
      height: Math.max(1, size.height)
    })
  })
</script>

<div
  class="fixed"
  style="left: {position.x}px; top: {position.y}px; width: {WIDTH}px"
  style:opacity={nativeArmed && !native.live ? 0 : 1}
  {@attach nativeMount}
>
  {#key comment?.referenceId ?? ''}
    {#if comment}
      <CommentBubble
        title={`Comment on ${comment.elementName}`}
        dragHandleTitle={`Move the comment on ${comment.elementName}`}
        initialComment={comment.comment}
        {targetId}
        {scope}
        onDraftChange={(text) => onDraftChange(comment.referenceId, text)}
        onDone={(text) => onDone(comment.referenceId, text)}
        onRemove={() => onRemove(comment.referenceId)}
        {onClose}
        {onExplain}
        {onQuickChat}
        chatSubject="design element"
        attach={attachBubble}
      />
    {/if}
  {/key}
</div>
