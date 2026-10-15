<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import type { Attachment } from 'svelte/attachments'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import { artifactThemeStyles } from './artifact-theme'
  import { sanitizedSvgArtifact } from './artifact'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import {
    clipElementText,
    svgElementReference,
    type ArtifactInspectorTarget
  } from '$lib/artifact-element-reference'
  import { referenceLabelNumber } from '$lib/reference-labels'
  import { MARK_TAP_SLOP_PX } from '$lib/annotation-marks'
  import type { PanZoom } from '$lib/pan-zoom.svelte'

  /**
   * The element inspector for one inline SVG artifact.
   *
   * A prototype in the app browser already lets a user pick an element and
   * describe it by its CSS path; an SVG artifact is the same kind of surface
   * rendered in the conversation, so it gets the same inspection. The picture is
   * re-rendered here as a shadow-root document   the artifact's own styles must
   * not escape into the app, and the app's layout must not leak back in   and a
   * hover box plus a pick turns the element under the pointer into a composer
   * reference carrying the same kind of descriptor the browser inspector sends.
   *
   * Only the picture is isolated. The hover box, the numbered pins, the hint and
   * the comment box are the app's own DOM placed in the viewer's own pixels, so
   * they are never scaled with the artifact while the viewer is zoomed.
   */
  interface Props {
    code: string
    artifactKey: string
    projectId: string
    threadId: string
    /** Picks already made on this artifact, in composer order. */
    picks: ResponseReferenceAnchor[]
    /** A pick whose comment the user asked to edit from the composer. */
    editingId: string | null
    /** The comment editor closed, so the caller can clear its request. */
    onEditClosed: () => void
    /** Escape left the inspector, so the card returns to the plain preview. */
    onExit: () => void
    /** The expanded viewer's zoom, shared with its preview so the view the user
     *  zoomed into is the view they pick in. */
    panZoom: PanZoom
  }

  let {
    code,
    artifactKey,
    projectId,
    threadId,
    picks,
    editingId,
    onEditClosed,
    onExit,
    panZoom
  }: Props = $props()

  /**
   * The surface and its isolated document.
   *
   * Both are reactive rather than plain locals: the pins and the open editor's
   * anchor are derived from them, and a derived that read a plain variable would
   * keep the empty answer it computed on the render pass before the attachment
   * ran, never noticing that the artifact had been mounted underneath it.
   */
  let host = $state<HTMLDivElement | null>(null)
  let shadowRoot = $state<ShadowRoot | null>(null)
  /** The viewer's own box, which every control on the artifact is placed in. */
  let frame = $state<HTMLDivElement | null>(null)
  /** The element under the pointer, outlined while it would be picked. */
  let hoverName = $state<string | null>(null)
  /** The pick whose editor this surface opened by itself. */
  let localEditingId = $state<string | null>(null)
  /** Bumped whenever the open editor must re-measure against the layout. */
  let measureToken = $state(0)

  /** Pin elements by reference id, so the editor anchors to its own pin. */
  const pinElements = new SvelteMap<string, HTMLElement>()

  /**
   * The pick whose comment is open.
   *
   * A pick made or re-opened on this surface outranks the card's jump request:
   * the user's latest action is the one they are looking at. A request the card
   * still holds (a jump whose pick was since removed) must never shadow a pick
   * the user just made   that reads as an inspector that ignores every click.
   */
  const activeEditingId = $derived(localEditingId ?? editingId)
  const editingPick = $derived(
    activeEditingId ? (picks.find((pick) => pick.id === activeEditingId) ?? null) : null
  )

  /**
   * Where the open editor anchors: its pin, re-measured as the layout moves.
   *
   * The pin is the anchor of choice, but never the only one. A pick is made and
   * its editor opens in the same frame, before the pin has been mounted and
   * measured, so an anchor that waited for the pin would drop the editor for a
   * pick the user had just made. The element the pick names stands in, and the
   * surface itself after that, so a pick is always commentable.
   */
  const editorAnchor = $derived.by(() => {
    void measureToken
    const pick = editingPick
    if (!pick) return null
    const pin = pinElements.get(pick.id)
    if (pin) return anchorBelow(pin.getBoundingClientRect())
    const root = shadowRoot
    const element = root ? resolvePick(root, pick) : null
    if (element) return anchorBelow(element.getBoundingClientRect())
    const box = frame?.getBoundingClientRect() ?? host?.getBoundingClientRect()
    return box ? { x: box.left + box.width / 2, y: box.top + 48 } : null
  })

  function anchorBelow(rect: DOMRect): { x: number; y: number } {
    return { x: rect.left + rect.width / 2, y: rect.bottom }
  }

  /**
   * Where each pick's pin belongs.
   *
   * Every pick stores a CSS path, and the pin is placed from the element that
   * path resolves to right now rather than from the rectangle it had when it was
   * picked: an SVG that re-renders (a resized pane, a new theme, a data update)
   * moves its elements, and a pin left at the old coordinates would point at
   * nothing. The viewer's own untransformed box is subtracted from the element's
   * (already zoomed) rectangle, so a pin lands on its element at any zoom while
   * the pin itself keeps its size. A pick whose element no longer exists draws no
   * pin, and its comment stays readable from the composer.
   */
  const pins = $derived.by(() => {
    void measureToken
    const root = shadowRoot
    const box = frame?.getBoundingClientRect()
    if (!root || !box) return []
    return picks.flatMap((pick, index) => {
      const element = resolvePick(root, pick)
      if (!element) return []
      const rect = element.getBoundingClientRect()
      return [
        {
          id: pick.id,
          number: referenceLabelNumber(pick.label, index),
          hasComment: Boolean(pick.comment),
          label: pick.text.split('\n')[0]?.replace(/^SVG artifact element:\s*/u, '') ?? pick.label,
          x: rect.left - box.left + rect.width / 2,
          y: rect.top - box.top + rect.height / 2
        }
      ]
    })
  })

  /**
   * The attachment that registers one pick's pin, kept per pick so a re-render
   * re-uses it.
   *
   * Svelte re-runs an attachment whose expression is a new function, and the pin
   * map is reactive because the open editor follows its own pin; a fresh closure
   * per render would therefore write the map the editor reads on every render,
   * which is an update loop rather than a layout. The cache is keyed by the pick
   * and dropped with the pin it belongs to.
   */
  const pinAttachments = new SvelteMap<string, Attachment<HTMLButtonElement>>()

  function pinAttachment(id: string): Attachment<HTMLButtonElement> {
    const existing = pinAttachments.get(id)
    if (existing) return existing
    const attachment: Attachment<HTMLButtonElement> = (node) => {
      pinElements.set(id, node)
      return () => {
        pinElements.delete(id)
        pinAttachments.delete(id)
      }
    }
    pinAttachments.set(id, attachment)
    return attachment
  }

  /**
   * The artifact's root `<svg>`, reached from the element the pointer is on.
   *
   * Read from the gesture rather than searched for separately: a root lookup that
   * came back empty used to end the pick before it was stored, so an element the
   * user could hover was an element they could not comment on.
   */
  function pickRoot(element: SVGElement): Element {
    return element.closest('svg') ?? element
  }

  function resolvePick(root: ShadowRoot, pick: ResponseReferenceAnchor): SVGElement | null {
    const selector = pick.selector
    if (!selector) return null
    try {
      const found = root.querySelector(selector)
      return found instanceof SVGElement ? found : null
    } catch {
      // A path can stop matching after an artifact changes; a pick without a
      // resolvable element simply has no pin.
      return null
    }
  }

  /** `path#id.cls`, the short form used in labels and context. */
  function shortName(element: Element): string {
    let name = element.tagName.toLowerCase()
    if (element.id) name += `#${element.id}`
    const classes = (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    if (classes.length > 0) name += `.${classes.slice(0, 2).join('.')}`
    return name
  }

  /** A CSS path from the artifact's SVG root down to the picked element. */
  function cssPath(element: Element, root: Element): string {
    const segments: string[] = []
    let current: Element | null = element
    while (current) {
      if (current.id) {
        segments.unshift(`#${CSS.escape(current.id)}`)
        break
      }
      let segment = current.tagName.toLowerCase()
      const parent: Element | null = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (child) => child.tagName === current?.tagName
        )
        if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
      segments.unshift(segment)
      if (current === root) break
      current = parent
    }
    return segments.join(' > ')
  }

  function ancestorNames(element: Element, root: Element): string[] {
    const names: string[] = []
    let current = element.parentElement
    while (current && names.length < 6) {
      names.unshift(shortName(current))
      if (current === root) break
      current = current.parentElement
    }
    return names
  }

  function describeTarget(element: SVGElement, root: Element): ArtifactInspectorTarget {
    const rect = element.getBoundingClientRect()
    return {
      selector: cssPath(element, root),
      tag: element.tagName.toLowerCase(),
      id: element.id || null,
      classes: (element.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 12),
      text: clipElementText((element.textContent ?? '').trim().replace(/\s+/gu, ' ')),
      ancestors: ancestorNames(element, root),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
    }
  }

  /** The deepest element of the artifact under the pointer, if any. */
  function targetUnderPointer(event: Event): SVGElement | null {
    for (const node of event.composedPath()) {
      if (node === host) return null
      if (node instanceof SVGElement) return node
    }
    return null
  }

  /** The element under the pointer, which a keyboard pick would take. */
  let hoveredElement = $state<SVGElement | null>(null)

  /**
   * The hover box, in the viewer's pixels.
   *
   * Derived rather than written once, so a zoom, a pan or a resize moves the box
   * with the element under the pointer instead of leaving it behind at the
   * coordinates the element had when the pointer last moved.
   */
  const hoverRect = $derived.by(() => {
    void measureToken
    const element = hoveredElement
    const box = frame?.getBoundingClientRect()
    if (!element || !box) return null
    const rect = element.getBoundingClientRect()
    return {
      x: rect.left - box.left,
      y: rect.top - box.top,
      width: rect.width,
      height: rect.height
    }
  })

  function handlePointerMove(event: PointerEvent): void {
    const target = targetUnderPointer(event)
    hoveredElement = target
    hoverName = target ? shortName(target) : null
  }

  function handlePointerLeave(): void {
    hoveredElement = null
    hoverName = null
  }

  /**
   * The gesture that takes a pick.
   *
   * The pick is taken on release, exactly as the annotation pen takes a mark on
   * a picture: a pointer gesture is what a surface the user is pointing at
   * receives, and it cannot be swallowed by anything that suppresses the click
   * the browser would otherwise fire. Movement past the tap slop makes the
   * gesture a pan of a zoomed artifact, not a pick.
   */
  let pressOrigin: { x: number; y: number } | null = null

  function handlePointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !event.isPrimary) return
    pressOrigin = { x: event.clientX, y: event.clientY }
  }

  function handlePointerUp(event: PointerEvent): void {
    const origin = pressOrigin
    pressOrigin = null
    if (!origin) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MARK_TAP_SLOP_PX) return
    const target = pickTarget(event)
    if (!target) return
    // The release is an inspection, not a click on the artifact: nothing inside
    // the SVG should react to it.
    event.preventDefault()
    void addPick(describeTarget(target, pickRoot(target)))
  }

  /**
   * The element a pick at this gesture takes.
   *
   * A release that never landed on a painted element (an artifact's own margin, a
   * gap between its shapes) still means the artifact, so the root stands in
   * rather than the gesture doing nothing at all.
   */
  function pickTarget(event: Event): SVGElement | null {
    return targetUnderPointer(event) ?? shadowRoot?.querySelector<SVGSVGElement>('svg') ?? null
  }

  /**
   * The keyboard path to the same pick.
   *
   * The surface takes focus when it is clicked, and then Enter or Space comments
   * on the element the pointer is outlining. It is how a pick is finished
   * without leaving the keyboard after a hover, and it is what makes the surface
   * a control rather than a bare click target.
   */
  function handleSurfaceKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return
    const target = hoveredElement ?? shadowRoot?.querySelector<SVGSVGElement>('svg') ?? null
    if (!target) return
    event.preventDefault()
    void addPick(describeTarget(target, pickRoot(target)))
  }

  async function addPick(target: ArtifactInspectorTarget): Promise<void> {
    const id = crypto.randomUUID()
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [
      ...current,
      svgElementReference(id, target, artifactKey)
    ])
    // The store caps how many references a thread holds, so a pick beyond the
    // cap never opens an editor for a reference that was not kept.
    if (!responseReferencesState.forThread(projectId, threadId).some((entry) => entry.id === id)) {
      return
    }
    localEditingId = id
    // The pin the editor anchors to is drawn by the update the store just caused,
    // so the measurement waits for that frame instead of landing before it.
    await tick()
    measureToken += 1
  }

  function requestEdit(id: string): void {
    localEditingId = id
    measureToken += 1
  }

  function closeEditor(): void {
    localEditingId = null
    onEditClosed()
  }

  function saveComment(id: string, comment: string): void {
    responseReferencesState.updateComment(projectId, threadId, id, comment)
    closeEditor()
  }

  function draftComment(id: string, comment: string): void {
    responseReferencesState.updateCommentDraft(projectId, threadId, id, comment)
  }

  function removePick(id: string): void {
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(
      projectId,
      threadId,
      current.filter((reference) => reference.id !== id)
    )
    pinElements.delete(id)
    closeEditor()
  }

  function remeasure(): void {
    // Guarded on the props and the hover alone: reading the placed pins here would
    // make the measurement effect read the state it writes.
    if (!activeEditingId && picks.length === 0 && !hoveredElement) return
    measureToken += 1
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // The comment field owns Escape while it is open.
    if (activeEditingId) return
    hoveredElement = null
    hoverName = null
    // Leaving inspection claims the key. The inspector can be drawn inside the
    // expanded artifact viewer, and an Escape that dismissed that viewer as well
    // would throw away the picks the user just made.
    event.preventDefault()
    onExit()
  }

  /**
   * Build the isolated document the artifact is inspected in.
   *
   * The SVG is sanitized exactly as the preview sanitizes it, then placed inline
   * rather than wrapped in an `<img>` data URL, because an element can only be
   * picked in the DOM. It lives in a shadow root so the artifact's own `<style>`
   * cannot restyle the app and the app's CSS cannot restyle the artifact.
   */
  const shadowSheet = $derived(`:host { display: block; height: 100%; }
.cio-stage { position: relative; box-sizing: border-box; display: flex; height: 100%; align-items: center; justify-content: center; padding: 1.25rem; background: var(--color-app); }
.cio-stage > svg { max-width: 100%; max-height: 100%; height: auto; width: auto; font-family: var(--font-app); color: var(--color-foreground); fill: currentColor; }`)

  function artifactMarkup(): string {
    return `<div class="cio-stage">${sanitizedSvgArtifact(code)}</div>`
  }

  function mountInspector(node: HTMLDivElement): void {
    host = node
    shadowRoot = node.attachShadow({ mode: 'open' })
  }

  /** The untransformed box every control on the artifact is placed in. */
  function frameAttachment(node: HTMLDivElement): () => void {
    frame = node
    return () => {
      if (frame === node) frame = null
    }
  }

  // The artifact's source and the app's theme can both change while the card is
  // mounted, so the isolated document is rebuilt from them rather than written
  // once at mount.
  $effect(() => {
    const root = shadowRoot
    const sheet = shadowSheet
    const theme = artifactThemeStyles()
    if (!root) return
    root.innerHTML = `<style>${theme}${sheet}</style>${artifactMarkup()}`
  })

  // A zoom or a pan moves every element the pins, the hover box and the open
  // editor are placed from, so the surface re-measures once the view it draws has
  // actually moved. Measuring from inside a derived would read the rectangles the
  // artifact still had before the transform landed.
  $effect(() => {
    void panZoom.zoom
    void panZoom.panX
    void panZoom.panY
    // The transform lands after this effect's own flush, so the pins, the hover
    // box and the open editor are re-measured on the next frame, once the view
    // they are placed against has actually moved. Deferring it also keeps this
    // effect dependent on the zoom alone: a measurement taken here would read the
    // very state it then writes, and the surface would loop instead of settling.
    const frame = requestAnimationFrame(() => remeasure())
    return () => cancelAnimationFrame(frame)
  })

  onDestroy(() => {
    pinElements.clear()
    pinAttachments.clear()
    shadowRoot = null
  })
</script>

<svelte:window onkeydown={handleKeydown} onscrollcapture={remeasure} onresize={remeasure} />

<div class="relative h-full w-full" {@attach frameAttachment}>
  <!-- Only the artifact itself carries the viewer's zoom. The hover box, the pins
       and the comment box are the app's own DOM placed in this box's pixels, so
       the controls keep their size and stay on their elements at any zoom. -->
  <div class="h-full w-full" style={panZoom.transform} {@attach panZoom.bindTarget}>
    <!-- The picking surface is pointer-driven by nature, exactly like the element
         picker the browser panel uses: an element is chosen by pointing at it. The
         role says so, and the keyboard path is Enter or Space on the element the
         pointer is on, so the interaction is not pointer-only. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div
      class="h-full w-full overflow-hidden"
      data-artifact-inspector
      role="application"
      aria-label="Artifact element inspector: hover an element and click, or press Enter, to comment on it"
      tabindex="0"
      {@attach mountInspector}
      onpointerdown={handlePointerDown}
      onpointerup={handlePointerUp}
      onpointermove={handlePointerMove}
      onpointerleave={handlePointerLeave}
      onkeydown={handleSurfaceKeydown}
    ></div>
  </div>

  {#if hoverRect}
    <div
      class="pointer-events-none absolute z-10 border border-accent bg-accent/15"
      style:left={`${hoverRect.x}px`}
      style:top={`${hoverRect.y}px`}
      style:width={`${hoverRect.width}px`}
      style:height={`${hoverRect.height}px`}
    ></div>
  {/if}

  <!-- The pins live in app DOM rather than inside the artifact: they are app
       controls (focusable, labelled, clickable), and the host never scrolls, so
       an app-space position stays on the element it points at. -->
  {#each pins as pin (pin.id)}
    <button
      type="button"
      class="absolute z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center border-2 border-white bg-accent text-[0.625rem] font-semibold text-on-accent shadow-md transition-transform hover:scale-110"
      style:left={`${pin.x}px`}
      style:top={`${pin.y}px`}
      title={pin.hasComment
        ? `Edit comment on ${pin.label}`
        : `Comment on ${pin.label} (${pin.number})`}
      aria-label={pin.hasComment
        ? `Edit comment on ${pin.label}`
        : `Comment on ${pin.label} (${pin.number})`}
      onclick={() => requestEdit(pin.id)}
      {@attach pinAttachment(pin.id)}
    >
      {pin.number}
    </button>
  {/each}

  <div
    class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-2 bg-black/55 px-2 py-1 text-[0.625rem] font-medium text-white"
  >
    <span aria-live="polite">
      {hoverName ? `Click ${hoverName} to comment` : 'Hover an element and click to comment'}
    </span>
    <span class="opacity-80">Esc to finish</span>
  </div>
</div>

{#if editingPick && editorAnchor}
  <ResponseAnnotationComment
    x={editorAnchor.x}
    y={editorAnchor.y}
    title="Comment on SVG element"
    dragHandleTitle="Move element comment"
    closeLabel="Close element comment"
    removeTitle="Remove this element and its comment"
    initialComment={editingPick.comment ?? ''}
    targetId={`svg-element-comment-${threadId}-${editingPick.id}`}
    scope={{ kind: 'project', projectId }}
    allowEmptyRemove
    onDraftChange={(comment) => draftComment(editingPick.id, comment)}
    onDone={(comment) => saveComment(editingPick.id, comment)}
    onRemove={() => removePick(editingPick.id)}
    onClose={closeEditor}
  />
{/if}
