<script lang="ts">
  import InlineImageFigure from './InlineImageFigure.svelte'
  import AnnotationMarkLayer from './AnnotationMarkLayer.svelte'
  import { markDescriptor, type MarkCapture } from '$lib/annotation-marks'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte.ts'

  /**
   * The mark surface for one inline artifact picture.
   *
   * It exists to answer one question the shared layer cannot: what is behind the
   * marks. Here that is a still the agent published, named by its part URL, and
   * the host's whole job is to hand the layer that URL and to turn a stroke into
   * a reference on it. The drawing, the numbered badges, the comment editor and
   * the pen all live in {@link AnnotationMarkLayer}, which a video frame uses too.
   */
  interface Props {
    projectId: string
    threadId: string
    url: string
    mime: string
    filename: string
    imageUrls: FileBlobUrlManager
    /** The message the picture arrived in, so a mark can be jumped back to. */
    messageId?: string
    /** Marks already drawn on this picture, in composer order. */
    marks: ResponseReferenceAnchor[]
    /** A mark whose comment the user asked to edit from elsewhere. */
    editingId: string | null
    /** Open the fullscreen viewer. */
    onExpand: () => void
    /** The comment editor closed, so the caller can clear its request. */
    onEditClosed: () => void
  }

  let {
    projectId,
    threadId,
    url,
    mime,
    filename,
    imageUrls,
    messageId,
    marks,
    editingId,
    onExpand,
    onEditClosed
  }: Props = $props()

  /** Whether the pointer draws on the picture instead of opening it. */
  let armed = $state(false)

  function handleArmedChange(next: boolean): void {
    armed = next
  }

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

{#snippet markLayer()}
  <AnnotationMarkLayer
    {projectId}
    {threadId}
    {marks}
    {createMark}
    {editingId}
    {onEditClosed}
    {armed}
    onArmedChange={handleArmedChange}
    hint="Draw on the picture · Esc to finish"
  />
{/snippet}

<InlineImageFigure {url} {mime} {filename} {imageUrls} {onExpand} overlay={markLayer} />
