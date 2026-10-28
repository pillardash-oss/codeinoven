<script lang="ts">
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import type { CompositionFrameSnapshot } from '$shared/ipc-contract'
  import { setAnnotationToolbarHost } from '$lib/annotation-toolbar'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import Modal from '../ui/Modal.svelte'
  import ArtifactImageAnnotator from '../threads/ArtifactImageAnnotator.svelte'

  /**
   * A note on one frame of a composition.
   *
   * A composition is a page, not a file, so "that moment there" has nowhere to
   * live on disk until someone captures it. The transport pauses the playhead,
   * main draws and keeps the frame, and this surface is where the user circles
   * the area they mean and says what is wrong with it.
   *
   * It is a media lightbox, not a form: the frame at full size, the same pen and
   * the same comment bubble every artifact picture already uses, and the band
   * naming the moment sitting where an artifact's header sits. The pen, its
   * colour and the control that finishes annotating are drawn by the mark layer
   * itself and mounted inside that band, which is how an artifact picture in the
   * conversation gets them: one toolbar, one comment editor, two kinds of picture.
   *
   * The strokes are what reach the agent, and each one carries the moment: the
   * descriptor names the composition, the timecode to the millisecond, the exact
   * second and the frame index, so the frame it sees and the frame it must fix
   * stay the same one after the edit moves the timeline.
   */
  interface Props {
    projectId: string
    threadId: string
    snapshot: CompositionFrameSnapshot
    /** Whether the pen starts armed: the pen button opens this surface to draw. */
    armed: boolean
    /**
     * The mark whose comment is open, when the surface was opened on one.
     *
     * A composer jump names the mark it wants edited; the layer opens that
     * mark's editor once its badge is measured, which is the same path a badge
     * clicked on the picture takes.
     */
    editingId?: string | null
    /** That editor closed, so the caller can drop the request it came from. */
    onEditClosed?: () => void
    /**
     * The marks to draw, when the surface was opened on a moment that already
     * has them.
     *
     * A capture writes a new picture at a new path, so the strokes drawn on an
     * earlier capture of the same second do not name this URL. The caller that
     * reopened the moment hands them over instead, and they are drawn on the
     * picture because they are about this frame, not about that file.
     */
    marks?: ResponseReferenceAnchor[]
    onClose: () => void
  }

  let {
    projectId,
    threadId,
    snapshot,
    armed,
    editingId = null,
    onEditClosed = () => {},
    marks: openedMarks,
    onClose
  }: Props = $props()

  /**
   * The band where the mark layer's own controls are mounted.
   *
   * A full screen picture is the only place a mark is big enough to draw, and
   * this header is where the app puts the controls that belong to it, so the
   * layer appends its pen here instead of floating a second toolbar over the
   * picture.
   */
  let annotationToolbar = $state<HTMLDivElement>()
  setAnnotationToolbarHost({ target: () => annotationToolbar })

  /**
   * The strokes already drawn on this frame.
   *
   * A capture is written to its own path, so a surface is normally opened with
   * nothing on it. Reading them rather than assuming empty keeps a reopened
   * frame honest: the strokes are in the composer, and the layer draws whatever
   * the composer holds for this picture.
   */
  const marks = $derived(
    openedMarks ??
      responseReferencesState
        .forThread(projectId, threadId)
        .filter((entry) => entry.kind === 'image' && entry.mediaUrl === snapshot.url)
  )

  /** What the agent reads about the moment, in the same shape a video note uses. */
  const detail = $derived(
    [
      `Composition: ${snapshot.directory}`,
      `timecode: ${snapshot.timecode}`,
      `seconds: ${snapshot.seconds.toFixed(3)}`,
      `frame: ${snapshot.frame} (at ${snapshot.fps} fps)`,
      `duration: ${snapshot.duration}`,
      `frame picture: ${snapshot.path}`
    ].join('\n')
  )
</script>

<Modal
  open
  title={`Frame ${snapshot.timecode}`}
  {onClose}
  placement="fullscreen"
  chrome={false}
  panelClass="bg-black/70"
  claimInitialFocus={(panel) => {
    panel.querySelector<HTMLElement>('button')?.focus()
    return true
  }}
>
  <!-- A chrome-less lightbox, so this band is the header: it reserves the same
       inset the app header occupies over the top-left corner, names the exact
       moment, and carries the pen and the dismiss control. -->
  <div
    class="titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-white/10 pr-3"
    style={trafficLightInsetStyle()}
  >
    <span
      class="flex shrink-0 items-center gap-1.5 font-mono text-xs font-semibold text-white/90"
      title={`Frame ${snapshot.frame} of ${snapshot.directory}`}
    >
      <CioClapper size={12} class="text-white/60" />
      {snapshot.timecode}
    </span>
    <span class="shrink-0 tabular-nums text-xs text-white/60">frame {snapshot.frame}</span>
    <span class="shrink-0 tabular-nums text-xs text-white/60">{snapshot.fps} fps</span>
    <span class="min-w-0 truncate text-xs text-white/50" title={snapshot.directory}>
      {snapshot.directory}
    </span>
    <span class="shrink-0 tabular-nums text-xs text-white/40">
      {snapshot.width}×{snapshot.height}
    </span>
    <div
      class="titlebar-no-drag ml-auto min-w-0"
      {@attach (node) => {
        annotationToolbar = node
        return () => {
          annotationToolbar = undefined
        }
      }}
    ></div>
    <button
      type="button"
      class="titlebar-no-drag ml-1 flex h-7 w-7 shrink-0 items-center justify-center text-white/70 transition-colors hover:bg-white/10 hover:text-white"
      aria-label="Close the frame note"
      title="Close (Esc)"
      onclick={onClose}
    >
      <CioMinimize size={14} />
    </button>
  </div>
  <div class="relative flex min-h-0 flex-1 items-center justify-center">
    <ArtifactImageAnnotator
      {projectId}
      {threadId}
      url={snapshot.url}
      filename={snapshot.path}
      {marks}
      moment={{
        seconds: snapshot.seconds,
        timecode: snapshot.timecode,
        detail,
        directory: snapshot.directory
      }}
      startArmed={armed}
      {editingId}
      {onEditClosed}
    />
  </div>
</Modal>
