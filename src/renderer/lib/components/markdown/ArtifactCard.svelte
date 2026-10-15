<script lang="ts">
  import { onDestroy } from 'svelte'
  import { artifactThemeStyles } from './artifact-theme'
  import { artifactKeyFor } from '$lib/artifact-element-reference'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { artifactElementFocusState } from '$lib/stores/artifact-element-focus.svelte'
  import ArtifactInspector from './ArtifactInspector.svelte'
  import {
    Check,
    Code2,
    Copy,
    Expand,
    Eye,
    SquareDashedMousePointer,
    WrapText
  } from '@lucide/svelte'
  import { copyText } from '$lib/copy-text'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'
  import Modal from '../ui/Modal.svelte'
  import CodeBlock from './CodeBlock.svelte'
  import { buildArtifactSrcdoc, type ArtifactKind } from './artifact'

  interface Props {
    code: string
    kind: ArtifactKind
    /**
     * The conversation this artifact is drawn in.
     *
     * An SVG artifact can be inspected for an element when this is present: a
     * pick has to be stored against a conversation, so an artifact rendered
     * somewhere without one (a document preview, a spec studio) stays a plain
     * preview with no pick affordance.
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

  const label = $derived(kind === 'html' ? 'HTML artifact' : 'SVG artifact')
  const srcdoc = $derived(buildArtifactSrcdoc(kind, code, artifactThemeStyles()))
  const wrapped = $derived(wrapTextState.wrapped)
  const artifactKey = $derived(artifactKeyFor(kind, code))
  /** Inspection is an SVG-only affair: an HTML artifact has no element contract
   *  to send, and audio/video artifacts have nothing to point at. */
  const canInspect = $derived(kind === 'svg' && annotationScope !== undefined)

  const picks = $derived(
    annotationScope
      ? responseReferencesState
          .forThread(annotationScope.projectId, annotationScope.threadId)
          .filter((reference) => reference.kind === 'svg' && reference.artifactKey === artifactKey)
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
   * where a user makes it, so the inline card stays a plain preview. A composer
   * jump opens the viewer as well: the pick it names has nowhere else to be
   * commented on.
   */
  const viewerOpen = $derived(expanded || focusRequest !== null)
  /**
   * Only the expanded viewer ever draws the inspector.
   *
   * The inline card behind it would otherwise render a second pick surface, a
   * second pin on the same element and a second comment editor for the same
   * pick. The artifact at full size is where a pick is made, so the inline card
   * stays a plain preview whenever the viewer is open.
   */
  const inspecting = $derived(viewerOpen && (manualInspecting || focusRequest !== null))
  const inspectorEditingId = $derived(focusRequest?.referenceId ?? null)

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

{#snippet artifactBody(fullscreen = false)}
  {#if showSource && !fullscreen}
    <div class="[&>div]:border-0 [&>div]:border-t">
      <CodeBlock {code} lang={kind === 'html' ? 'artifact-html' : 'artifact-svg'} hideHeader />
    </div>
  {:else if inspecting && annotationScope && fullscreen}
    <div class="h-full min-h-0">
      <ArtifactInspector
        {code}
        {artifactKey}
        projectId={annotationScope.projectId}
        threadId={annotationScope.threadId}
        {picks}
        editingId={inspectorEditingId}
        onEditClosed={releaseFocusRequest}
        onExit={() => {
          releaseFocusRequest()
          manualInspecting = false
        }}
      />
    </div>
  {:else}
    <iframe
      title="{label} preview"
      sandbox=""
      {srcdoc}
      class={['block w-full border-0 bg-app', fullscreen ? 'h-full min-h-0' : 'h-80']}
    ></iframe>
  {/if}
{/snippet}

<div class="overflow-hidden border bg-elevated" data-artifact-key={artifactKey}>
  <div class="flex h-8 items-center justify-between border-b px-2">
    <span class="px-1 font-mono text-[0.625rem] uppercase tracking-wide text-dimmed">{label}</span>
    <div class="flex items-center gap-0.5">
      <div
        class="mr-1 flex items-center border border-border"
        role="group"
        aria-label="{label} view"
      >
        <button
          type="button"
          class={[
            'px-2 py-1 text-[0.625rem] font-medium transition-colors',
            !showSource ? 'bg-overlay text-foreground' : 'text-dimmed hover:text-foreground'
          ]}
          aria-pressed={!showSource}
          title="Show rendered {label} preview"
          onclick={() => (showSource = false)}
        >
          <span class="flex items-center gap-1"><Eye size={12} />Preview</span>
        </button>
        <button
          type="button"
          class={[
            'px-2 py-1 text-[0.625rem] font-medium transition-colors',
            showSource ? 'bg-overlay text-foreground' : 'text-dimmed hover:text-foreground'
          ]}
          aria-pressed={showSource}
          title="Show {label} source"
          onclick={() => (showSource = true)}
        >
          <span class="flex items-center gap-1"><Code2 size={12} />Code</span>
        </button>
      </div>
      <button
        class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label={wrapToggleLabel(wrapped)}
        title={wrapToggleLabel(wrapped)}
        aria-pressed={wrapped}
        onclick={() => wrapTextState.toggle()}
      >
        <WrapText size={13} class={wrapped ? 'text-primary' : ''} />
      </button>
      <button
        class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Copy {label} source"
        title="Copy {label} source"
        onclick={() => void copySource()}
      >
        {#if copied}
          <Check size={13} class="text-success" />
        {:else}
          <Copy size={13} />
        {/if}
      </button>
      <button
        class="p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label="Expand {label}"
        title="Expand {label}"
        onclick={() => (expanded = true)}
      >
        <Expand size={13} />
      </button>
    </div>
  </div>

  {@render artifactBody()}
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
    title={inspecting ? 'Stop inspecting this SVG' : 'Inspect: pick an element to comment on'}
    onclick={toggleInspect}
  >
    <SquareDashedMousePointer size={14} />
    <span>{inspecting ? 'Stop inspecting' : 'Inspect an element'}</span>
  </button>
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
  headerActions={canInspect ? inspectAction : undefined}
>
  <div class="min-h-0 flex-1">
    {@render artifactBody(true)}
  </div>
</Modal>
