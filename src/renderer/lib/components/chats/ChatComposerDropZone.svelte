<script lang="ts">
  import { Upload } from '@lucide/svelte'
  import type { Attachment } from 'svelte/attachments'
  import type { ComposerDropRegion } from './chat-composer-drop'

  interface Props {
    /** Region the overlay covers, or null when no file drag is over the
     *  conversation. The measurement anchor always renders. */
    region: ComposerDropRegion | null
    /** Reports the mounted anchor element so the host can resolve the overlay's
     *  fixed-position origin against it. */
    onAnchorChange: (element: HTMLElement | null) => void
    onDropFiles: (dataTransfer: DataTransfer | null) => void
    onClearDropState: () => void
  }

  let { region, onAnchorChange, onDropFiles, onClearDropState }: Props = $props()

  const captureDropAnchorProbe: Attachment<HTMLElement> = (element) => {
    onAnchorChange(element)
    return () => onAnchorChange(null)
  }
</script>

<!-- Measurement anchor for the overlay below: fixed, 0x0, and out of flow, so it
     never takes part in layout. It sits beside the overlay rather than inside
     .chat-composer (which sets container-type for its responsive toolbar) so the
     two always resolve against the same box. -->
<div
  {@attach captureDropAnchorProbe}
  aria-hidden="true"
  class="pointer-events-none fixed top-0 left-0 m-0 h-0 w-0"
></div>

{#if region}
  <!-- Sits over the conversation region only: the project sidebar (left) and
       the file tree (right) keep their own drop targets, so a drag can be aimed
       at any of the three surfaces. Sibling of .chat-composer, never a
       descendant: whether that element's container-type contains a fixed child
       is engine-dependent, so staying outside it removes the question. Where it
       lands comes from the anchor above, never from CSS inference. -->
  <div
    role="region"
    aria-label="Drop zone"
    class="fixed z-100 m-0 flex items-center justify-center border-2 border-dashed border-primary bg-primary/20 backdrop-blur-sm pointer-events-auto"
    style:left={`${region.left}px`}
    style:top={`${region.top}px`}
    style:width={`${region.width}px`}
    style:height={`${region.height}px`}
    ondragover={(e: DragEvent) => {
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }}
    ondrop={(e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onClearDropState()
      onDropFiles(e.dataTransfer)
    }}
  >
    <div class="flex flex-col items-center gap-2 text-primary">
      <Upload size={32} />
      <span class="text-base font-medium">Drop files to attach</span>
    </div>
  </div>
{/if}
