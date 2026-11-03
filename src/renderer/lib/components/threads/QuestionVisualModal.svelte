<script lang="ts">
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import Modal from '../ui/Modal.svelte'
  import DeferredMermaidDiagram from '../markdown/DeferredMermaidDiagram.svelte'
  import { artifactThemeStyles } from '../markdown/artifact-theme'
  import { buildArtifactSrcdoc } from '../markdown/artifact'
  import type { QuestionVisualSource } from './question-visual-source'

  /**
   * The picture behind a question's or an option's eye button.
   *
   * A decision about something that does not exist yet is made from what the
   * user can see, so the card carries the agent's smallest picture of it and
   * this modal is the one place it is shown at a readable size. The picture is
   * read-only: no source toggle, no copy, no inspection, because nothing here
   * is a document the user edits, only a drawing that answers "what would that
   * look like?".
   *
   * HTML and SVG are drawn in a sandboxed frame through the same sanitizers and
   * theme tokens an inline artifact uses, so a mockup stands in the app's own
   * palette rather than in a hardcoded one, and neither can execute anything.
   */
  interface Props {
    open: boolean
    /** What the eye button was opened on: the question itself, or one option. */
    title: string
    source: QuestionVisualSource | null
    onClose: () => void
  }

  let { open, title, source, onClose }: Props = $props()

  // Themes are read once per open rather than per render: a frame cannot follow
  // a live theme change, and a visual is looked at for a moment, not edited.
  const frameSrcDoc = $derived.by(() => {
    if (!open || !source) return null
    if (source.kind === 'html' || source.kind === 'svg') {
      return buildArtifactSrcdoc(source.kind, source.code, artifactThemeStyles())
    }
    return null
  })
</script>

<!-- Drawn in the app window so the picture is selectable and scrollable like the
     rest of the app; the native overlay projection cannot host a live frame. -->
<Modal
  {open}
  {onClose}
  {title}
  size="xl"
  fill
  nativePresentation={false}
  contentClass="flex flex-col overflow-hidden bg-app p-0"
>
  {#if source}
    <div class="flex min-h-0 flex-1 flex-col">
      {#if source.kind === 'mermaid'}
        <div class="min-h-0 flex-1 overflow-auto bg-surface p-4">
          <DeferredMermaidDiagram code={source.code} />
        </div>
      {:else if source.kind === 'image'}
        <div class="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-app p-4">
          <img
            src={source.src}
            alt={source.caption ?? title}
            class="max-h-full max-w-full object-contain"
          />
        </div>
      {:else if frameSrcDoc}
        <iframe
          srcdoc={frameSrcDoc}
          sandbox=""
          class="min-h-0 w-full flex-1 border-0 bg-app"
          title={source.caption ?? title}
        ></iframe>
      {/if}
      {#if source.caption}
        <p class="shrink-0 border-t border-border bg-surface px-4 py-2 text-xs text-muted">
          {source.caption}
        </p>
      {/if}
    </div>
  {:else}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-muted">
      <CioEye size={20} />
      <p class="text-xs">This visual could not be drawn.</p>
    </div>
  {/if}

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay"
      onclick={onClose}
    >
      Close
    </button>
  {/snippet}
</Modal>
