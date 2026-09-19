/**
 * Conversation-scoped file drop detection for the chat composer.
 *
 * Document-level listeners keep the detection simple, but a drag is only
 * captured while the pointer is inside the conversation region. The project
 * sidebar (left) and the file tree (right) therefore keep their own drop
 * targets: dragging right imports into the project, dragging left adds a
 * project, and only the conversation attaches files to the message.
 */

export interface ComposerDropRegion {
  left: number
  top: number
  width: number
  height: number
}

export interface ComposerDropContext {
  getReadOnlyMode(): boolean
  getAllowAttachments(): boolean
  getSelectedHarnessLacksAttachments(): boolean
  getComposerRoot(): HTMLElement | null
  getDropAnchorProbe(): HTMLElement | null
  setDragging(value: boolean): void
  setDropRegion(region: ComposerDropRegion | null): void
  setAttachmentBlockedNotice(value: boolean): void
  handleDropFiles(dataTransfer: DataTransfer | null): void | Promise<void>
}

/**
 * Surfaces that own their own OS file drop: the project file tree (imports
 * into the project) and the project sidebar (folders become projects, single
 * files open standalone). Their regions are checked before the conversation
 * because the sidebar's collapsed overlay and the file tree's dock both sit on
 * top of the conversation column, so a point inside the conversation may still
 * be an element the composer must not capture as an attachment.
 */
const SELF_HANDLED_DROP_REGIONS = '[data-region="file-tree"], [data-drop-region="sidebar"]'

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false
  // `types` can be a DOMStringList (contains) or FrozenArray (includes).
  const types = Array.from(dt.types ?? [])
  return types.includes('Files')
}

function insideRect(rect: DOMRect, e: { clientX: number; clientY: number }): boolean {
  return (
    e.clientX >= rect.left &&
    e.clientX <= rect.right &&
    e.clientY >= rect.top &&
    e.clientY <= rect.bottom
  )
}

/** True when the pointer is inside a surface that handles the drop itself. */
function overSelfHandledDropRegion(e: { clientX: number; clientY: number }): boolean {
  const regions = document.querySelectorAll<HTMLElement>(SELF_HANDLED_DROP_REGIONS)
  for (const region of regions) {
    if (region.offsetParent === null) continue
    if (insideRect(region.getBoundingClientRect(), e)) return true
  }
  return false
}

/**
 * Install the document-level drag listeners and return the disposer.
 *
 * Registering once on mount and gating each handler on the current mode flags
 * (read at event time through the context getters) keeps the listener lifecycle
 * and the drag state mutations out of a reactive effect.
 */
export function installComposerDropListeners(ctx: ComposerDropContext): () => void {
  /** Hide the drop overlay. Every path that leaves the "file drag over the
   *  conversation" state funnels through here, so the overlay cannot outlive the
   *  drag it belongs to. */
  function clearDropState(): void {
    ctx.setDragging(false)
    ctx.setDropRegion(null)
  }

  /** The conversation region this composer belongs to, if it has one. */
  function conversationRegion(): HTMLElement | null {
    return ctx.getComposerRoot()?.closest<HTMLElement>('[data-drop-region="conversation"]') ?? null
  }

  /** Geometry of the conversation region, or null when the composer is not
   *  mounted inside one (e.g. a host that renders it standalone). */
  function conversationRegionRect(): DOMRect | null {
    const region = conversationRegion()
    if (!region) return null
    const rect = region.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    return rect
  }

  /**
   * Origin the drop overlay's `position: fixed` resolves against.
   *
   * Measured from the anchor element instead of inferred from the ancestor CSS,
   * because the ancestor that contains a fixed box is not the one the CSS
   * suggests. The conversation column declares `container-type` for its composer
   * container queries, and containment from `container-type` is supposed to
   * bring layout containment with it, which would make that column the containing
   * block: Chromium does not do that (only an explicit `contain: layout`/`paint`,
   * `transform`, `filter`, `backdrop-filter` or `will-change` creates one),
   * while other engines may follow the specification. Measuring a 0x0 fixed
   * anchor reports whatever the running engine actually does, so the overlay
   * lands on the region on every engine and keeps landing there if a `transform`,
   * a `filter`, or any other containing ancestor is introduced above it later.
   */
  function fixedOrigin(): { x: number; y: number } {
    const rect = ctx.getDropAnchorProbe()?.getBoundingClientRect()
    // No anchor mounted (a host that renders the composer standalone): the
    // overlay is fixed against the viewport, which is where the anchor would be.
    return rect ? { x: rect.left, y: rect.top } : { x: 0, y: 0 }
  }

  function onDragOver(e: DragEvent): void {
    // A drag that stops being droppable part way through (the composer went
    // read-only, or the selected harness cannot take attachments) must not
    // leave an overlay that an earlier event of the same drag raised.
    if (ctx.getReadOnlyMode() && !ctx.getAllowAttachments()) {
      clearDropState()
      return
    }
    if (ctx.getSelectedHarnessLacksAttachments()) {
      clearDropState()
      return
    }
    if (!hasFiles(e.dataTransfer)) return
    const rect = conversationRegionRect()
    if (!rect || !insideRect(rect, e) || overSelfHandledDropRegion(e)) {
      // Outside the conversation (or over a surface that owns the drop): leave
      // it to whichever surface owns that region and hide the overlay.
      clearDropState()
      return
    }
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    const origin = fixedOrigin()
    ctx.setDropRegion({
      left: rect.left - origin.x,
      top: rect.top - origin.y,
      width: rect.width,
      height: rect.height
    })
    ctx.setDragging(true)
  }

  function onDragLeave(e: DragEvent): void {
    // The overlay is shown only while a file drag is inside the conversation, so
    // any leave that is not the drag moving onto one of the region's own
    // children hides it. Testing the pointer rather than the event target keeps
    // the overlay up through those child crossings.
    //
    // The viewport boundary is tested explicitly on top of the region: every
    // layout puts the region flush against the window's right and bottom edges
    // (and the left edge where the conversation is full bleed), so a leave
    // produced by dragging out of the window lands inside the region's bounds
    // and would otherwise be read as a child crossing. Hiding it here also
    // covers the release that ends a drag over a surface which accepts no
    // drop: such a surface receives no drop event at all, leaving this as the
    // last event the composer sees.
    const atWindowEdge =
      e.clientX <= 0 ||
      e.clientY <= 0 ||
      e.clientX >= window.innerWidth ||
      e.clientY >= window.innerHeight
    const rect = conversationRegionRect()
    if (atWindowEdge || !rect || !insideRect(rect, e)) clearDropState()
  }

  function onDrop(e: DragEvent): void {
    // Every drop ends the drag, including one that lands on the sidebar, the
    // file tree, or outside the window.
    clearDropState()
    if (ctx.getReadOnlyMode() && !ctx.getAllowAttachments()) return
    if (ctx.getSelectedHarnessLacksAttachments()) {
      if (hasFiles(e.dataTransfer)) {
        e.preventDefault()
        ctx.setAttachmentBlockedNotice(true)
      }
      return
    }
    const rect = conversationRegionRect()
    if (!rect || !insideRect(rect, e) || overSelfHandledDropRegion(e)) return
    e.preventDefault()
    void ctx.handleDropFiles(e.dataTransfer)
  }

  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop)

  return () => {
    document.removeEventListener('dragover', onDragOver)
    document.removeEventListener('dragleave', onDragLeave)
    document.removeEventListener('drop', onDrop)
  }
}
