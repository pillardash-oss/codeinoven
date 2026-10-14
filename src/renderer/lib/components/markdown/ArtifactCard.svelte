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
  const inspecting = $derived(manualInspecting || focusRequest !== null)
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
    <div class="[&>div]:rounded-none [&>div]:border-0 [&>div]:border-t">
      <CodeBlock {code} lang={kind === 'html' ? 'artifact-html' : 'artifact-svg'} hideHeader />
    </div>
  {:else if inspecting && annotationScope}
    <div class={fullscreen ? 'h-full min-h-0' : 'h-80'}>
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

<div class="overflow-hidden rounded-lg border bg-elevated" data-artifact-key={artifactKey}>
  <div class="flex h-8 items-center justify-between border-b px-2">
    <span class="px-1 font-mono text-[0.625rem] uppercase tracking-wide text-dimmed">{label}</span>
    <div class="flex items-center gap-0.5">
      <div
        class="mr-1 flex items-center rounded-md border border-border"
        role="group"
        aria-label="{label} view"
      >
        <button
          type="button"
          class={[
            'rounded-l-md px-2 py-1 text-[0.625rem] font-medium transition-colors',
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
            'rounded-r-md px-2 py-1 text-[0.625rem] font-medium transition-colors',
            showSource ? 'bg-overlay text-foreground' : 'text-dimmed hover:text-foreground'
          ]}
          aria-pressed={showSource}
          title="Show {label} source"
          onclick={() => (showSource = true)}
        >
          <span class="flex items-center gap-1"><Code2 size={12} />Code</span>
        </button>
      </div>
      {#if canInspect}
        <button
          type="button"
          class={[
            'rounded p-1 transition-colors',
            inspecting
              ? 'bg-overlay text-accent'
              : 'text-dimmed hover:bg-overlay hover:text-foreground'
          ]}
          aria-pressed={inspecting}
          title={inspecting ? 'Stop inspecting this SVG' : 'Inspect: pick an element to comment on'}
          aria-label={inspecting ? 'Stop inspecting this SVG' : 'Inspect this SVG'}
          onclick={toggleInspect}
        >
          <SquareDashedMousePointer size={13} />
        </button>
      {/if}
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
        aria-label={wrapToggleLabel(wrapped)}
        title={wrapToggleLabel(wrapped)}
        aria-pressed={wrapped}
        onclick={() => wrapTextState.toggle()}
      >
        <WrapText size={13} class={wrapped ? 'text-primary' : ''} />
      </button>
      <button
        class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
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
        class="rounded p-1 text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
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

<Modal
  open={expanded}
  title={label}
  onClose={() => (expanded = false)}
  placement="fullscreen"
  panelClass="bg-app"
  contentClass="flex flex-col overflow-hidden p-0"
>
  <div class="min-h-0 flex-1">
    {@render artifactBody(true)}
  </div>
</Modal>
