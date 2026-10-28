<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { annotationIndicatorElement } from '$lib/annotation-indicator.svelte'
  import ResponseAnnotationComment from '../chats/ResponseAnnotationComment.svelte'
  import AnnotationIndicator from '../shared/AnnotationIndicator.svelte'
  import { artifactThemeStyles } from './artifact-theme'
  import { sanitizedHtmlArtifactDocument, sanitizedSvgArtifact } from './artifact'
  import { ARTIFACT_STAGE_CLASS, ARTIFACT_STAGE_ID, type ArtifactKind } from './artifact'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import {
    artifactElementReference,
    clipElementText,
    type ArtifactInspectorTarget
  } from '$lib/artifact-element-reference'
  import { referenceLabelNumber } from '$lib/reference-labels'
  import { artifactInspectorChatContext, openAnnotationChat } from '$lib/annotation-chat'
  import { MARK_TAP_SLOP_PX } from '$lib/annotation-marks'
  import type { PanZoom } from '$lib/pan-zoom.svelte'

  /**
   * The element inspector for one inline artifact, HTML or SVG.
   *
   * A prototype in the app browser already lets a user pick an element and
   * describe it by its CSS path; an inline artifact is the same kind of surface
   * rendered in the conversation, so it gets the same inspection. The artifact is
   * re-rendered here as a shadow-root document   its own styles must not escape
   * into the app, and the app's layout must not leak back in   and a hover box
   * plus a pick turns the element under the pointer into a composer reference
   * carrying the same kind of descriptor the browser inspector sends.
   *
   * A picture and a document mount differently for the same reason. A picture
   * has its own root (`<svg>`) and is centred in a frame, so its selector path
   * starts there. A document is a body of markup with no root of its own, so it
   * is mounted in the stage box and its path starts at that box; the document's
   * own `html`/`body`/`:root` rules are rewritten to the stage, so a page that
   * styles its own canvas still styles the box it is drawn in.
   *
   * Only the picture is isolated. The hover box, the numbered pins, the hint and
   * the comment box are the app's own DOM placed in the viewer's own pixels, so
   * they are never scaled with the artifact while the viewer is zoomed.
   */
  interface Props {
    code: string
    /** The artifact kind, which decides how its source is mounted to be picked. */
    kind: ArtifactKind
    /** Picking is armed only by the viewer's explicit inspect mode. */
    enabled: boolean
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
    /**
     * Whether the surface fills a fixed box instead of flowing in the message.
     *
     * It fills the viewer, which is a window of its own: a document artifact
     * there is the scroll container and a picture is centred in it. In the
     * conversation the same surface is part of the column, so it takes the
     * height its content has and the page scrolls, exactly as the message
     * around it does.
     */
    fill: boolean
  }

  let {
    code,
    kind,
    enabled,
    artifactKey,
    projectId,
    threadId,
    picks,
    editingId,
    onEditClosed,
    onExit,
    panZoom,
    fill
  }: Props = $props()

  /** How this surface names its artifact to the user. */
  const surface = $derived(kind === 'svg' ? 'SVG' : 'HTML')

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

  /** The indicator surface this viewer draws its picks on. */
  const indicatorSurface = $derived(`artifact:${threadId}:${artifactKey}`)

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
   *
   * The pin is asked for rather than tracked: the shared annotation indicator
   * registers the element it drew, which is the same fixture every other surface
   * would otherwise repeat.
   */
  const editorAnchor = $derived.by(() => {
    void measureToken
    const pick = editingPick
    if (!pick) return null
    const pin = annotationIndicatorElement(indicatorSurface, pick.id)
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
   * picked: an artifact that re-renders (a resized pane, a new theme, a data
   * update)
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
          label:
            pick.text.split('\n')[0]?.replace(/^(?:SVG|HTML) artifact element:\s*/u, '') ??
            pick.label,
          x: rect.left - box.left + rect.width / 2,
          y: rect.top - box.top + rect.height / 2
        }
      ]
    })
  })

  /** The document's stage box, which is the root an HTML artifact is picked in. */
  function stageRoot(): Element | null {
    return shadowRoot?.querySelector(`.${ARTIFACT_STAGE_CLASS}`) ?? null
  }

  /**
   * The root the artifact's own element lives in.
   *
   * Read from the gesture rather than searched for separately: a root lookup that
   * came back empty used to end the pick before it was stored, so an element the
   * user could hover was an element they could not comment on.
   */
  function pickRoot(element: Element): Element {
    if (kind === 'html') return stageRoot() ?? element
    return element.closest('svg') ?? element
  }

  /** The artifact's own root, which a pick that landed on nothing still takes. */
  function fallbackTarget(): Element | null {
    const root = shadowRoot
    if (!root) return null
    return kind === 'svg'
      ? root.querySelector('svg')
      : root.querySelector(`.${ARTIFACT_STAGE_CLASS}`)
  }

  /** The deepest element of the artifact under the pointer, if any. */
  function targetUnderPointer(event: Event): Element | null {
    // The stage is the document's own box rather than an element of the
    // artifact, so a pointer in its padding is pointing at the artifact itself
    // and the pick falls back to the stage.
    const stage = kind === 'html' ? stageRoot() : null
    for (const node of event.composedPath()) {
      if (node === host) return null
      if (node instanceof Element) return node === stage ? null : node
    }
    return null
  }

  /** The element under the pointer, which a keyboard pick would take. */
  let hoveredElement = $state<Element | null>(null)

  function resolvePick(root: ShadowRoot, pick: ResponseReferenceAnchor): Element | null {
    const selector = pick.selector
    if (!selector) return null
    try {
      return root.querySelector(selector)
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

  /** A CSS path from the artifact's root down to the picked element. */
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

  function describeTarget(element: Element, root: Element): ArtifactInspectorTarget {
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
    if (!enabled) return
    const target = targetUnderPointer(event)
    hoveredElement = target
    hoverName = target ? shortName(target) : null
  }

  function handlePointerLeave(): void {
    hoveredElement = null
    hoverName = null
  }

  /**
   * Let the artifact itself keep its own clicks.
   *
   * While inspecting, a click is a pick and nothing inside the artifact may
   * react to it.
   *
   * Otherwise this surface is the same preview the conversation draws inline, so
   * it has to behave like one: a disclosure, a label bound to its control, a
   * checkbox, a styled button or a focusable field in the document all get their
   * own default action. Cancelling every click here is what made a fullscreen
   * HTML artifact inert while the very same artifact was usable in the chat.
   *
   * The one action still refused is navigation. An inline artifact has no
   * sandbox around it, so an anchor it carries would navigate the app's own
   * window if its default action were left alone.
   */
  function handleArtifactClick(event: MouseEvent): void {
    if (enabled) {
      event.preventDefault()
      return
    }
    const navigating = event
      .composedPath()
      .some((node) => node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement)
    if (navigating) event.preventDefault()
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
    if (!enabled || event.button !== 0 || !event.isPrimary) return
    pressOrigin = { x: event.clientX, y: event.clientY }
  }

  function handlePointerUp(event: PointerEvent): void {
    const origin = pressOrigin
    pressOrigin = null
    if (!enabled || !origin || panZoom.isPanning) return
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > MARK_TAP_SLOP_PX) return
    const target = pickTarget(event)
    if (!target) return
    // The release is an inspection, not a click on the artifact: nothing inside
    // the artifact should react to it.
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
  function pickTarget(event: Event): Element | null {
    return targetUnderPointer(event) ?? fallbackTarget()
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
    if (!enabled || (event.key !== 'Enter' && event.key !== ' ')) return
    const target = hoveredElement ?? fallbackTarget()
    if (!target) return
    event.preventDefault()
    void addPick(describeTarget(target, pickRoot(target)))
  }

  async function addPick(target: ArtifactInspectorTarget): Promise<void> {
    const id = crypto.randomUUID()
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [
      ...current,
      artifactElementReference(id, target, artifactKey, kind)
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

  /**
   * Ask about the open pick from its own comment bubble.
   *
   * The side chat asks about the same descriptor the composer chip carries, so a
   * user can have the element explained, or talk it through, before committing a
   * word of the comment. The pick is captured before the editor closes, because
   * closing drops the derived pick the request is built from, and the artifact's
   * own source rides along so the chat reads the element where it actually lives.
   */
  function openChatAboutEditingPick(mode: 'elaborate' | 'quick'): void {
    const pick = editingPick
    if (!pick) return
    openAnnotationChat({
      projectId,
      threadId,
      mode,
      selection: pick.text,
      context: artifactInspectorChatContext(kind, code, surface)
    })
    closeEditor()
  }

  function removePick(id: string): void {
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(
      projectId,
      threadId,
      current.filter((reference) => reference.id !== id)
    )
    closeEditor()
  }

  function remeasure(): void {
    // Guarded on the props and the hover alone: reading the placed pins here would
    // make the measurement effect read the state it writes.
    if (!activeEditingId && picks.length === 0 && !hoveredElement) return
    measureToken += 1
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (!enabled || event.key !== 'Escape') return
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
   * The source is sanitized exactly as the preview sanitizes it, then placed
   * inline rather than wrapped in an `<img>` data URL or mounted in a sandboxed
   * frame, because an element can only be picked in the DOM. It lives in a shadow
   * root so the artifact's own `<style>` cannot restyle the app and the app's CSS
   * cannot restyle the artifact.
   */
  /**
   * The rules the isolated document always carries.
   *
   * The stage is the box the artifact is drawn in, and it stands in for the
   * document a page would otherwise own: the app's surface, the app's type, and
   * the pointer cursor that says an element can be picked. An artifact's own
   * rules are placed after this sheet, so a page that styles its own canvas still
   * wins, exactly as it does in the preview.
   *
   * `contain: paint` is what keeps an artifact inside the box it is given. The
   * surface is drawn in the app's own document rather than in a sandboxed frame,
   * so without it a page could paint over the conversation around it (a fixed
   * element in an artifact would otherwise be laid out against the window).
   *
   * Where the surface is drawn is a host attribute rather than a value baked into
   * this sheet. The sheet is what rebuilds the artifact's own DOM, and a rebuild
   * is a reset: opening the viewer on a filled surface would have re-created the
   * tab the reader had just checked.
   */
  const stageSheet = `:host { display: block; contain: paint; }
:host([data-fill]) { height: 100%; }
.${ARTIFACT_STAGE_CLASS} { position: relative; box-sizing: border-box; background: var(--color-app); font-family: var(--font-app); color: var(--color-foreground); }
:host([data-fill]) .${ARTIFACT_STAGE_CLASS} { height: 100%; }
.${ARTIFACT_STAGE_CLASS} img, .${ARTIFACT_STAGE_CLASS} video { max-width: 100%; height: auto; }
:host([data-inspecting]) .${ARTIFACT_STAGE_CLASS}, :host([data-inspecting]) .${ARTIFACT_STAGE_CLASS} * { cursor: pointer !important; }`

  /**
   * A picture is centred and contained; a document is laid out.
   *
   * In the viewer the document is also the scroll container, because the viewer
   * is a fixed window on it. In the conversation the document flows instead: it
   * has no height of its own to scroll inside, so the message column scrolls.
   */
  const kindSheet = $derived(
    kind === 'svg'
      ? `.${ARTIFACT_STAGE_CLASS} { display: flex; align-items: center; justify-content: center; padding: 1.25rem; }
.${ARTIFACT_STAGE_CLASS} > svg { max-width: 100%; width: 100%; height: auto; fill: currentColor; }
:host([data-fill]) .${ARTIFACT_STAGE_CLASS} > svg { width: auto; max-height: 100%; }`
      : `:host([data-fill]) .${ARTIFACT_STAGE_CLASS} { overflow: auto; }`
  )

  /**
   * The stage box and the two sheets that style it.
   *
   * The isolated document has three parts, and only one of them is the
   * artifact: the token sheet (theme, stage rules, kind rules), the artifact's
   * own rules, and the artifact markup itself. Keeping them apart is what lets
   * the theme change without touching the artifact. A theme nudge (a theme
   * switch, a body attribute a modal sets while it opens) used to rewrite the
   * whole shadow document, which re-created the tabs and disclosures the reader
   * had already used, so the surface reset itself under their pointer.
   */
  let sheetEl = $state<HTMLStyleElement | null>(null)
  let sourceSheetEl = $state<HTMLStyleElement | null>(null)
  let stageEl = $state<HTMLElement | null>(null)

  function mountInspector(node: HTMLDivElement): void {
    host = node
    const root = node.attachShadow({ mode: 'open' })
    root.innerHTML = `<style data-cio-sheet></style><style data-cio-source></style><div class="${ARTIFACT_STAGE_CLASS}" id="${ARTIFACT_STAGE_ID}"></div>`
    sheetEl = root.querySelector('style[data-cio-sheet]')
    sourceSheetEl = root.querySelector('style[data-cio-source]')
    stageEl = root.querySelector(`.${ARTIFACT_STAGE_CLASS}`)
    shadowRoot = root
  }

  /** The untransformed box every control on the artifact is placed in. */
  function frameAttachment(node: HTMLDivElement): () => void {
    frame = node
    return () => {
      if (frame === node) frame = null
    }
  }

  /** An SVG picture, drawn inline so its own elements can be pointed at. */
  function svgMarkup(source: string): string {
    const template = document.createElement('template')
    template.innerHTML = sanitizedSvgArtifact(source)
    // An SVG image has its own :root. Inside a shadow tree those declarations
    // must belong to the host, or authored aliases such as --ink disappear.
    for (const style of template.content.querySelectorAll('style')) {
      style.textContent = (style.textContent ?? '').replace(/:root\b/gu, ':host')
    }
    return template.innerHTML
  }

  // The app's theme, restated for the artifact's own document. Only a sheet is
  // written, never the artifact, so the artifact keeps its state.
  $effect(() => {
    const sheet = sheetEl
    if (!sheet) return
    const theme = artifactThemeStyles().replace(/:root\b/gu, ':host')
    sheet.textContent = `${theme}${stageSheet}${kindSheet}`
  })

  // The artifact itself, rewritten only when its source does. A document keeps
  // its own `<style>` rules, which are emitted after the stage sheet so the
  // artifact's canvas overrides it, and are already rewritten for the stage box
  // because a shadow tree is what they now style.
  let appliedSource: string | null = null
  $effect(() => {
    const stage = stageEl
    const sourceSheet = sourceSheetEl
    const key = `${kind}\u0000${code}`
    if (!stage || !sourceSheet || appliedSource === key) return
    appliedSource = key
    if (kind === 'svg') {
      sourceSheet.textContent = ''
      stage.innerHTML = svgMarkup(code)
      return
    }
    const artifact = sanitizedHtmlArtifactDocument(code)
    sourceSheet.textContent = artifact.styles
    stage.innerHTML = artifact.markup
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
    shadowRoot = null
  })
</script>

<svelte:window onkeydown={handleKeydown} onscrollcapture={remeasure} onresize={remeasure} />

<div class={['relative w-full', fill && 'h-full']} {@attach frameAttachment}>
  <!-- Only the artifact itself carries the viewer's zoom. The hover box, the pins
       and the comment box are the app's own DOM placed in this box's pixels, so
       the controls keep their size and stay on their elements at any zoom. -->
  <div
    class={['w-full', fill && 'h-full']}
    style={panZoom.transform}
    {@attach panZoom.bindTarget}
  >
    <!-- The picking surface is pointer-driven by nature, exactly like the element
         picker the browser panel uses: an element is chosen by pointing at it. The
         role says so, and the keyboard path is Enter or Space on the element the
         pointer is on, so the interaction is not pointer-only. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class={['w-full', fill ? 'h-full overflow-hidden' : 'overflow-visible']}
      data-artifact-inspector
      data-inspecting={enabled ? '' : undefined}
      data-fill={fill ? '' : undefined}
      role={enabled ? 'application' : kind === 'svg' ? 'img' : 'document'}
      aria-label={enabled
        ? 'Artifact element inspector: hover an element and click, or press Enter, to comment on it'
        : `${surface} artifact preview`}
      tabindex={enabled ? 0 : undefined}
      onclick={handleArtifactClick}
      {@attach mountInspector}
      onpointerdown={handlePointerDown}
      onpointerup={handlePointerUp}
      onpointercancel={() => (pressOrigin = null)}
      onpointermove={handlePointerMove}
      onpointerleave={handlePointerLeave}
      onkeydown={handleSurfaceKeydown}
    ></div>
  </div>

  {#if enabled && hoverRect}
    <div
      class="pointer-events-none absolute z-10 border border-accent bg-accent/15"
      style:left={`${hoverRect.x}px`}
      style:top={`${hoverRect.y}px`}
      style:width={`${hoverRect.width}px`}
      style:height={`${hoverRect.height}px`}
    ></div>
  {/if}

  <!-- The pins live in app DOM rather than inside the artifact: they are app
       controls (focusable, draggable, clickable), and the host never scrolls, so
       an app-space position stays on the element it points at. They are the
       app's one annotation indicator rather than a pin of their own, so a pick
       made here can be dragged off the element it marks exactly like a pick made
       on a picture, a document passage or a specification. -->
  {#each pins as pin (pin.id)}
    <AnnotationIndicator
      id={pin.id}
      surface={indicatorSurface}
      left={`${pin.x}px`}
      top={`${pin.y}px`}
      centre
      number={pin.number}
      hasComment={pin.hasComment}
      active={activeEditingId === pin.id}
      title={pin.hasComment
        ? `Edit the comment on ${pin.label}. Drag to move it, click to edit.`
        : `Comment on ${pin.label} (${pin.number}). Drag to move it, click to write.`}
      class="z-20"
      onOpen={() => requestEdit(pin.id)}
    />
  {/each}

  {#if enabled}
    <div
      class="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-2 bg-black/55 px-2 py-1 text-[0.625rem] font-medium text-white"
    >
      <span aria-live="polite">
        {hoverName ? `Click ${hoverName} to comment` : 'Hover an element and click to comment'}
      </span>
      <span class="opacity-80">Esc to finish</span>
    </div>
  {/if}
</div>

{#if editingPick && editorAnchor}
  <ResponseAnnotationComment
    x={editorAnchor.x}
    y={editorAnchor.y}
    title="Comment on {surface} element"
    dragHandleTitle="Move element comment"
    closeLabel="Close element comment"
    removeTitle="Remove this element and its comment"
    initialComment={editingPick.comment ?? ''}
    targetId={`${kind}-element-comment-${threadId}-${editingPick.id}`}
    scope={{ kind: 'project', projectId }}
    onDraftChange={(comment) => draftComment(editingPick.id, comment)}
    onDone={(comment) => saveComment(editingPick.id, comment)}
    onRemove={() => removePick(editingPick.id)}
    onClose={closeEditor}
    chatSubject="artifact element"
    onExplain={() => openChatAboutEditingPick('elaborate')}
    onQuickChat={() => openChatAboutEditingPick('quick')}
  />
{/if}
