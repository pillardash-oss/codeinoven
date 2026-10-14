<script lang="ts">
  import { onDestroy } from 'svelte'
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

  /**
   * The element inspector for one inline SVG artifact.
   *
   * A prototype in the app browser already lets a user pick an element and
   * describe it by its CSS path; an SVG artifact is the same kind of surface
   * rendered in the conversation, so it gets the same inspection. The picture is
   * re-rendered here as a shadow-root document   the artifact's own styles must
   * not escape into the app, and the app's layout must not leak back in   and a
   * hover outline plus a click turns the element under the pointer into a
   * compositor reference carrying the same kind of descriptor the browser
   * inspector sends.
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
  }

  let { code, artifactKey, projectId, threadId, picks, editingId, onEditClosed, onExit }: Props =
    $props()

  let host: HTMLDivElement | null = null
  let shadowRoot: ShadowRoot | null = null
  let mounted = $state(false)
  /** The element under the pointer, outlined while it would be picked. */
  let hoverName = $state<string | null>(null)
  /** The pick whose editor this surface opened by itself. */
  let localEditingId = $state<string | null>(null)
  /** Bumped whenever the open editor must re-measure against the layout. */
  let measureToken = $state(0)

  /** Pin elements by reference id, so the editor anchors to its own pin. */
  const pinElements = new SvelteMap<string, HTMLElement>()

  const activeEditingId = $derived(editingId ?? localEditingId)
  const editingPick = $derived(
    activeEditingId ? (picks.find((pick) => pick.id === activeEditingId) ?? null) : null
  )

  /** Where the open editor anchors: its pin, re-measured as the layout moves. */
  const editorAnchor = $derived.by(() => {
    void measureToken
    const pick = editingPick
    if (!pick) return null
    const pin = pinElements.get(pick.id)
    if (!pin) return null
    const rect = pin.getBoundingClientRect()
    return { x: rect.left + rect.width / 2, y: rect.bottom }
  })

  /**
   * Where each pick's pin belongs.
   *
   * Every pick stores a CSS path, and the pin is placed from the element that
   * path resolves to right now rather than from the rectangle it had when it was
   * picked: an SVG that re-renders (a resized pane, a new theme, a data update)
   * moves its elements, and a pin left at the old coordinates would point at
   * nothing. A pick whose element no longer exists draws no pin, and its comment
   * stays readable from the composer.
   */
  const pins = $derived.by(() => {
    void measureToken
    const root = shadowRoot
    const box = host?.getBoundingClientRect()
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

  function pinAttachment(id: string): Attachment<HTMLButtonElement> {
    return (node) => {
      pinElements.set(id, node)
      return () => pinElements.delete(id)
    }
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
  let hoveredElement: SVGElement | null = null

  /** Move the shadow document's outline onto the element about to be picked. */
  function outline(element: SVGElement | null): void {
    const box = shadowRoot?.querySelector<HTMLElement>('.cio-outline')
    const frame = host?.getBoundingClientRect()
    if (!box || !frame) return
    if (!element) {
      box.hidden = true
      return
    }
    const rect = element.getBoundingClientRect()
    box.hidden = false
    box.style.left = `${rect.left - frame.left}px`
    box.style.top = `${rect.top - frame.top}px`
    box.style.width = `${rect.width}px`
    box.style.height = `${rect.height}px`
  }

  function handlePointerMove(event: PointerEvent): void {
    const target = targetUnderPointer(event)
    hoveredElement = target
    outline(target)
    hoverName = target ? shortName(target) : null
  }

  function handlePointerLeave(): void {
    hoveredElement = null
    outline(null)
    hoverName = null
  }

  function handleClick(event: MouseEvent): void {
    const root = shadowRoot?.querySelector('svg')
    const target = targetUnderPointer(event)
    if (!root || !target) return
    // The click is an inspection, not a click on the artifact: nothing inside the
    // SVG should react to it.
    event.preventDefault()
    event.stopPropagation()
    addPick(describeTarget(target, root))
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
    const root = shadowRoot?.querySelector('svg')
    const target = hoveredElement
    if (!root || !target) return
    event.preventDefault()
    addPick(describeTarget(target, root))
  }

  function addPick(target: ArtifactInspectorTarget): void {
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
    if (!activeEditingId && pins.length === 0) return
    measureToken += 1
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    // The comment field owns Escape while it is open.
    if (activeEditingId) return
    outline(null)
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
.cio-stage > svg { max-width: 100%; max-height: 100%; height: auto; width: auto; font-family: var(--font-app); color: var(--color-foreground); fill: currentColor; }
.cio-outline { position: absolute; pointer-events: none; border: 1.5px solid var(--color-accent); border-radius: 2px; background: color-mix(in srgb, var(--color-accent) 14%, transparent); }
.cio-outline[hidden] { display: none; }`)

  function artifactMarkup(): string {
    return `<div class="cio-stage">${sanitizedSvgArtifact(code)}<div class="cio-outline" hidden></div></div>`
  }

  function mountInspector(node: HTMLDivElement): void {
    host = node
    shadowRoot = node.attachShadow({ mode: 'open' })
    mounted = true
  }

  // The artifact's source and the app's theme can both change while the card is
  // mounted, so the isolated document is rebuilt from them rather than written
  // once at mount.
  $effect(() => {
    const root = shadowRoot
    const sheet = shadowSheet
    const theme = artifactThemeStyles()
    if (!mounted || !root) return
    root.innerHTML = `<style>${theme}${sheet}</style>${artifactMarkup()}`
  })

  onDestroy(() => {
    pinElements.clear()
    shadowRoot = null
  })
</script>

<svelte:window onkeydown={handleKeydown} onscrollcapture={remeasure} onresize={remeasure} />

<div class="relative h-full w-full">
  <!-- The picking surface is pointer-driven by nature, exactly like the element
       picker the browser panel uses: an element is chosen by pointing at it. The
       role says so, and the keyboard path is Enter or Space on the element the
       pointer is outlining, so the interaction is not pointer-only. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
  <div
    class="h-full w-full overflow-hidden"
    data-artifact-inspector
    role="application"
    aria-label="Artifact element inspector: hover an element and click, or press Enter, to comment on it"
    tabindex="0"
    {@attach mountInspector}
    onpointermove={handlePointerMove}
    onpointerleave={handlePointerLeave}
    onclick={handleClick}
    onkeydown={handleSurfaceKeydown}
  ></div>

  <!-- The pins live in app DOM rather than inside the artifact: they are app
       controls (focusable, labelled, clickable), and the host never scrolls, so
       an app-space position stays on the element it points at. -->
  {#each pins as pin (pin.id)}
    <button
      type="button"
      class="absolute z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 border-white bg-accent text-[0.625rem] font-semibold text-on-accent shadow-md transition-transform hover:scale-110"
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
