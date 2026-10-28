<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioMarquee from '@pdslng/cio-icon/CioMarquee.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioWrapText from '@pdslng/cio-icon/CioWrapText.svelte'
  import { onDestroy } from 'svelte'
  import { artifactKeyFor, artifactReferenceKind } from '$lib/artifact-element-reference'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { artifactElementFocusState } from '$lib/stores/artifact-element-focus.svelte'
  import ArtifactInspector from './ArtifactInspector.svelte'
  import { copyText } from '$lib/copy-text'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'
  import { PanZoom } from '$lib/pan-zoom.svelte'
  import PanZoomToolbar from '../ui/PanZoomToolbar.svelte'
  import Modal from '../ui/Modal.svelte'
  import CodeBlock from './CodeBlock.svelte'
  import type { ArtifactKind } from './artifact'

  interface Props {
    code: string
    kind: ArtifactKind
    /**
     * The conversation this artifact is drawn in.
     *
     * An artifact can be inspected for an element when this is present: a pick
     * has to be stored against a conversation, so an artifact rendered somewhere
     * without one (a document preview, a spec studio) stays a plain preview with
     * no pick affordance.
     */
    annotationScope?: { projectId: string; threadId: string }
  }

  let { code, kind, annotationScope }: Props = $props()

  let copied = $state(false)
  let expanded = $state(false)
  let showSource = $state(false)
  /** The inspect toggle the user flipped; a composer jump arms it too. */
  let manualInspecting = $state(false)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * The artifact's one surface, and the two homes it can be drawn in.
   *
   * The conversation card and the full-size viewer are the same artifact, so a
   * second mount is a second artifact: a tab the reader checked, a disclosure
   * they opened, a scroll position, a playing video would all live in the copy
   * that was just replaced, and the viewer would open on a reset artifact. The
   * surface is therefore rendered once and moved between the two homes, exactly
   * as the app's panels move between rails, so the viewer opens on the state the
   * reader left behind and every control in the artifact keeps working there.
   */
  let inlineHome = $state<HTMLDivElement | null>(null)
  let viewerHome = $state<HTMLDivElement | null>(null)
  let surface = $state<HTMLDivElement | null>(null)

  const label = $derived(kind === 'html' ? 'HTML artifact' : 'SVG artifact')
  const artifactKey = $derived(artifactKeyFor(kind, code))
  const wrapped = $derived(wrapTextState.wrapped)
  /** Inspection is offered on both kinds: an element of a picture or of a
   *  document is the same decision, and both send a CSS path to that element. */
  const canInspect = $derived(annotationScope !== undefined)

  const picks = $derived(
    annotationScope
      ? responseReferencesState
          .forThread(annotationScope.projectId, annotationScope.threadId)
          .filter(
            (reference) =>
              reference.kind === artifactReferenceKind(kind) &&
              reference.artifactKey === artifactKey
          )
      : []
  )

  // A pick's comment is written on the card that draws the artifact, while the
  // pick is listed in the composer, so the composer's edit action arrives here as
  // a request. It is read rather than copied into state: the request itself is
  // what arms inspection and names the pick to open, and closing that editor is
  // what consumes it, so there is nothing to keep in step.
  const focusRequest = $derived(
    annotationScope && canInspect
      ? artifactElementFocusState.pending(
          annotationScope.projectId,
          annotationScope.threadId,
          artifactKey
        )
      : null
  )
  /**
   * The expanded viewer, which is the only surface that offers the inspector.
   *
   * A pick is a decision about the artifact, and the artifact at full size is
   * where a user makes it, so the inline card stays an ordinary preview. A
   * composer jump opens the viewer as well: the pick it names has nowhere else
   * to be commented on.
   */
  const viewerOpen = $derived(expanded || focusRequest !== null)
  /**
   * Only the expanded viewer ever draws the inspector.
   *
   * The inline card behind it would otherwise render a second pick surface, a
   * second pin on the same element and a second comment editor for the same
   * pick. The artifact at full size is where a pick is made.
   */
  const inspecting = $derived(viewerOpen && (manualInspecting || focusRequest !== null))
  const inspectorEditingId = $derived(focusRequest?.referenceId ?? null)

  /**
   * The expanded viewer's zoom.
   *
   * One instance for the whole viewer, so the view the user zoomed into is the
   * surface they pick in. The threshold is what lets both work: a press that
   * does not move is a pick on the artifact, and a press that moves is a pan.
   *
   * A document artifact keeps the wheel for scrolling and zooms only on a
   * deliberate gesture (the zoom modifier held, or a toolbar button), while a
   * picture has nothing to scroll and keeps plain wheel zoom. The mode is read
   * through a getter, so the card follows the artifact it is drawing.
   */
  const panZoom = new PanZoom({
    dragThreshold: 4,
    wheel: () => (kind === 'html' ? 'scroll' : 'zoom')
  })
  let viewerViewport = $state<HTMLElement | undefined>(undefined)
  const viewerViewportAttachment = (node: HTMLElement): (() => void) => {
    viewerViewport = node
    return () => {
      if (viewerViewport === node) viewerViewport = undefined
    }
  }

  // A viewer reopened on another artifact must not inherit the last zoom.
  $effect(() => {
    if (!viewerOpen) panZoom.reset()
  })

  // The surface follows its home: the conversation while the artifact is read
  // there, the viewer while it is open. Nothing is re-created on the way, so the
  // state the reader left in it is the state they find on the other side.
  $effect(() => {
    const element = surface
    const home = viewerOpen ? viewerHome : inlineHome
    if (!element || !home || element.parentElement === home) return
    home.appendChild(element)
  })

  onDestroy(() => clearTimeout(copyResetTimer))

  async function copySource(): Promise<void> {
    try {
      await copyText(code, null)
      copied = true
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copied = false), 1500)
    } catch {
      // Clipboard unavailable   the button simply stays idle.
    }
  }

  /** Release a composer jump once its editor is done, so it never reopens. */
  function releaseFocusRequest(): void {
    const request = focusRequest
    if (request) artifactElementFocusState.consume(request.token)
  }

  /** Close the expanded viewer. A jump it was serving is spent either way. */
  function closeViewer(): void {
    releaseFocusRequest()
    manualInspecting = false
    expanded = false
  }

  function toggleInspect(): void {
    if (!canInspect) return
    // Read the mode before releasing a jump: consuming the request is what the
    // derived mode is watching, so asking afterwards would answer the new state.
    const wasInspecting = inspecting
    releaseFocusRequest()
    manualInspecting = !wasInspecting
  }
</script>

<!-- The artifact's home in the conversation. It carries no box of its own: the
     artifact is part of the message column, so it draws in the same surface the
     message does rather than inside a framed preview. -->
<div bind:this={inlineHome} class="relative"></div>

{#snippet viewToggle(withExpand: boolean)}
  <div class="flex items-center" role="group" aria-label="{label} view">
    <button
      type="button"
      class={[
        'flex size-6 items-center justify-center transition-colors',
        showSource ? 'text-dimmed hover:bg-overlay hover:text-foreground' : 'bg-overlay text-foreground'
      ]}
      aria-pressed={!showSource}
      title="Show rendered {label} preview"
      aria-label="Show rendered {label} preview"
      onclick={() => (showSource = false)}
    >
      <CioEye size={13} />
    </button>
    <button
      type="button"
      class={[
        'flex size-6 items-center justify-center transition-colors',
        showSource ? 'bg-overlay text-foreground' : 'text-dimmed hover:bg-overlay hover:text-foreground'
      ]}
      aria-pressed={showSource}
      title="Show {label} source"
      aria-label="Show {label} source"
      onclick={() => (showSource = true)}
    >
      <CioCode size={13} />
    </button>
  </div>
  {#if showSource}
    <button
      class="flex size-6 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label={wrapToggleLabel(wrapped)}
      title={wrapToggleLabel(wrapped)}
      aria-pressed={wrapped}
      onclick={() => wrapTextState.toggle()}
    >
      <CioWrapText size={13} class={wrapped ? 'text-primary' : ''} />
    </button>
  {/if}
  <button
    class="flex size-6 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
    aria-label="Copy {label} source"
    title="Copy {label} source"
    onclick={() => void copySource()}
  >
    {#if copied}
      <CioCheck size={13} class="text-success" />
    {:else}
      <CioCopy size={13} />
    {/if}
  </button>
  {#if withExpand}
    <button
      class="flex size-6 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label="Expand {label}"
      title="Expand {label}"
      onclick={() => (expanded = true)}
    >
      <CioMaximize size={13} />
    </button>
  {/if}
{/snippet}

<!-- The one surface. Rendered here first and moved to the viewer when it opens;
     never rebuilt, so nothing inside it is lost on the way.

     Both panes are mounted for the life of the card. The hidden one is taken out
     of the flow and of the tab order rather than destroyed, so switching to the
     source and back returns to the artifact the reader had already used, and the
     swap can cross-fade instead of blinking. -->
<div
  bind:this={surface}
  class={['group/md-artifact relative w-full', viewerOpen && 'h-full']}
  data-artifact-key={artifactKey}
>
  <!-- In the conversation the controls ride on the artifact and appear while it is
       under the pointer or holding focus, so the artifact reads as the content it
       is instead of a widget with a toolbar. They are sticky as well: an artifact
       taller than the window keeps its controls at the top of the conversation
       while it scrolls under it, and they are marked `no-drag` because the strip
       they meet there is the window's titlebar drag region. -->
  {#if !viewerOpen}
    <div class="pointer-events-none sticky top-3 z-30 h-0">
      <div
        class="titlebar-no-drag pointer-events-none ml-auto w-fit border border-border bg-surface p-1 opacity-0 shadow-lg transition-opacity duration-150 group-hover/md-artifact:pointer-events-auto group-hover/md-artifact:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
        role="group"
        aria-label="{label} controls"
      >
        <div class="flex items-center gap-0.5">
          {@render viewToggle(true)}
        </div>
      </div>
    </div>
  {/if}
  <div class={['relative w-full', viewerOpen && 'h-full']}>
    <div
      class={[
        'w-full transition-opacity duration-200 ease-out',
        showSource
          ? 'pointer-events-none absolute inset-0 overflow-hidden opacity-0'
          : 'relative opacity-100',
        viewerOpen && 'h-full'
      ]}
      inert={showSource}
    >
      <ArtifactInspector
        {code}
        {kind}
        enabled={inspecting}
        {artifactKey}
        projectId={annotationScope?.projectId ?? ''}
        threadId={annotationScope?.threadId ?? ''}
        {picks}
        editingId={inspectorEditingId}
        onEditClosed={releaseFocusRequest}
        {panZoom}
        fill={viewerOpen}
        onExit={() => {
          releaseFocusRequest()
          manualInspecting = false
        }}
      />
    </div>
    <div
      class={[
        'w-full transition-opacity duration-200 ease-out',
        showSource ? 'relative opacity-100' : 'pointer-events-none absolute inset-0 overflow-hidden opacity-0',
        viewerOpen && 'h-full'
      ]}
      inert={!showSource}
    >
      <CodeBlock {code} lang={kind === 'html' ? 'artifact-html' : 'artifact-svg'} hideHeader />
    </div>
  </div>


</div>

{#snippet inspectAction()}
  <button
    type="button"
    data-modal-primary
    class={[
      'flex h-7 items-center gap-1.5 border px-2.5 text-xs font-medium transition-colors',
      inspecting
        ? 'border-accent bg-accent/10 text-accent'
        : 'text-muted hover:bg-elevated hover:text-foreground'
    ]}
    aria-pressed={inspecting}
    title={inspecting ? 'Stop inspecting this artifact' : 'Inspect: pick an element to comment on'}
    onclick={toggleInspect}
  >
    <CioMarquee size={14} />
    <span>{inspecting ? 'Stop inspecting' : 'Inspect an element'}</span>
  </button>
{/snippet}

{#snippet viewerActions()}
  <div class="flex items-center gap-1.5">
    <div
      class="flex items-center gap-0.5 border border-border bg-elevated p-1"
      role="group"
      aria-label="{label} controls"
    >
      {@render viewToggle(false)}
    </div>
    {#if canInspect}
      {@render inspectAction()}
    {/if}
  </div>
{/snippet}

<Modal
  open={viewerOpen}
  title={label}
  onClose={closeViewer}
  onEscapeKeydown={(event) => {
    // Escape while inspecting leaves inspection rather than the viewer: the
    // picks the user just made are still being commented on here.
    if (!inspecting) return
    releaseFocusRequest()
    manualInspecting = false
    event.preventDefault()
  }}
  placement="fullscreen"
  panelClass="bg-app"
  contentClass="flex flex-col overflow-hidden p-0"
  headerActions={viewerActions}
>
  <!-- The viewer's own zoom surface, and the artifact's second home. The
       artifact inside it is the only element that carries the transform, so a
       toolbar or a control drawn next to it keeps its size and its place. -->
  <div class="relative min-h-0 flex-1">
    <div
      bind:this={viewerHome}
      {@attach viewerViewportAttachment}
      role="group"
      aria-label="Zoomable {label.toLowerCase()}"
      class={[
        'relative h-full w-full touch-none overflow-hidden',
        panZoom.zoom !== 1 && (panZoom.isPanning ? 'cursor-grabbing' : 'cursor-grab')
      ]}
      onwheel={panZoom.onWheel}
      onpointerdown={panZoom.onPointerDown}
      onpointermove={panZoom.onPointerMove}
      onpointerup={panZoom.onPointerUp}
      onpointercancel={panZoom.onPointerUp}
      ondblclick={() => panZoom.reset()}
    ></div>
    <PanZoomToolbar {panZoom} viewport={viewerViewport} class="absolute right-3 bottom-3 z-20" />
  </div>
</Modal>
