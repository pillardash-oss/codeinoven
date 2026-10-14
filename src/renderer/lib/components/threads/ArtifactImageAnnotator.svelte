<script lang="ts">
  import AnnotationMarkLayer from './AnnotationMarkLayer.svelte'
  import { markContentBox, markDescriptor, type MarkCapture } from '$lib/annotation-marks'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'

  /**
   * The mark surface for one artifact picture, drawn in the expanded viewer.
   *
   * The conversation shows an artifact picture plain. The pen, the numbered
   * badges and the comment bubble are all decisions about the picture, and the
   * place a user makes them is the picture at full size, so this host is the
   * lightbox (`chats/MediaPreview.svelte`) rather than the transcript.
   *
   * It owns the picture as well as the layer, and it places the layer on the
   * picture rather than on the box the lightbox gives it: the picture is fitted
   * inside that box, and a mark is normalized to the surface it was drawn in.
   */
  interface Props {
    projectId: string
    threadId: string
    /** The part URL of the picture, which is what a mark names its surface by. */
    url: string
    /** What to render: the part URL, or the blob URL resolved for it. */
    src?: string
    filename: string
    /** The message the picture arrived in, so a mark can be jumped back to. */
    messageId?: string
    /** Marks already drawn on this picture, in composer order. */
    marks: ResponseReferenceAnchor[]
    /** A mark whose comment the user asked to edit from elsewhere. */
    editingId: string | null
    /** The comment editor closed, so the caller can clear its request. */
    onEditClosed: () => void
  }

  let {
    projectId,
    threadId,
    url,
    src = url,
    filename,
    messageId,
    marks,
    editingId,
    onEditClosed
  }: Props = $props()

  /** The box the lightbox hands the picture, measured as it resizes. */
  let boxWidth = $state(0)
  let boxHeight = $state(0)
  /** The picture's own pixels, which is what decides its fit inside that box. */
  let pictureWidth = $state(0)
  let pictureHeight = $state(0)

  /** Whether the pointer draws on the picture instead of opening it. */
  let armed = $state(false)

  const contentBox = $derived(
    markContentBox(
      { width: boxWidth, height: boxHeight },
      { width: pictureWidth, height: pictureHeight }
    )
  )

  /**
   * Store one stroke as a reference on this picture.
   *
   * The id is minted here rather than by the layer, because the reference is what
   * names its surface: the same stroke means something different on another
   * picture, and on a video it also has to carry the second it was drawn at.
   */
  function createMark(capture: MarkCapture): string | null {
    const id = crypto.randomUUID()
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [
      ...current,
      {
        id,
        label: '',
        text: markDescriptor(filename, capture.points),
        kind: 'image',
        mediaUrl: url,
        markColor: capture.style.color,
        markStrokeWidth: capture.style.strokeWidth,
        markSurfaceEdge: capture.surfaceEdge,
        ...(messageId ? { messageId } : {}),
        points: capture.points
      }
    ])
    // The store caps how many references a thread may hold and numbers the
    // labels it actually kept, so a mark beyond the cap never opens an editor
    // for a reference that does not exist.
    return responseReferencesState.forThread(projectId, threadId).some((entry) => entry.id === id)
      ? id
      : null
  }
</script>

<div class="flex h-full min-h-0 w-full items-center justify-center p-4">
  <div class="relative h-full w-full" bind:offsetWidth={boxWidth} bind:offsetHeight={boxHeight}>
    <img
      class="absolute inset-0 h-full w-full object-contain"
      {src}
      alt={filename}
      draggable="false"
      bind:naturalWidth={pictureWidth}
      bind:naturalHeight={pictureHeight}
    />
    {#if contentBox}
      <!-- The layer fills the picture rather than the box the lightbox gave it:
           outside this box there is letterbox, and a mark belongs on the
           picture. -->
      <div
        class="absolute"
        style:left={`${contentBox.left}px`}
        style:top={`${contentBox.top}px`}
        style:width={`${contentBox.width}px`}
        style:height={`${contentBox.height}px`}
      >
        <AnnotationMarkLayer
          {projectId}
          {threadId}
          {marks}
          {createMark}
          {editingId}
          {onEditClosed}
          {armed}
          onArmedChange={(next) => (armed = next)}
          hint="Draw on the picture · Esc to finish"
        />
      </div>
    {/if}
  </div>
</div>
