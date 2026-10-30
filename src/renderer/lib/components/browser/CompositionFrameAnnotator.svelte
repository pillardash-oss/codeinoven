<script lang="ts">
  import type { BrowserViewBounds, CompositionFrameSnapshot } from '$shared/ipc-contract'
  import { markContentBox, markDescriptor, type MarkCapture } from '$lib/annotation-marks'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import AnnotationMarkLayer from '../threads/AnnotationMarkLayer.svelte'

  /**
   * The pen on one frame of a composition, drawn where the composition plays.
   *
   * A composition is a page, not a file, so "that moment there" has nowhere to
   * live on disk until someone captures it. The transport stops the playhead, main
   * draws and keeps the frame, and this surface is where the user circles the area
   * they mean and says what is wrong with it.
   *
   * It is not a modal, because there is nothing to open: the video editor is
   * already the full screen surface, and covering it with a dialog meant leaving
   * the player, the timeline and its own control row behind. So the captured frame
   * is drawn exactly over the pane the live page occupies and nothing else: the pen
   * and its colour are the transport's own pen control in that row, which becomes
   * the finish mark while this surface is up, so the picture keeps every pixel it
   * had and no second toolbar is invented over it. Pressing the continue key hands
   * the pane back and lets it run, so a user marking several moments does it in one
   * pass instead of opening, drawing, closing and reopening for each frame.
   *
   * The strokes are what reach the agent, and each one carries the moment: the
   * descriptor names the composition, the timecode to the millisecond, the exact
   * second and the frame index, so the frame it sees and the frame it must fix stay
   * the same one after the edit moves the timeline. The captured picture is the
   * evidence the send burns the marks onto.
   */
  interface Props {
    projectId: string
    threadId: string
    /** The frame main drew and kept, which is the picture the user draws on. */
    snapshot: CompositionFrameSnapshot
    /**
     * Show the frame and the comments it carries, without the pen.
     *
     * A frame that has marks is held whenever the reader lands on it and no pen is in
     * hand, so the marks are visible where they were drawn and each of the several
     * comments one frame can carry can be opened from its own badge.
     */
    readOnly?: boolean
    /**
     * The rectangle the live page occupies, in viewport pixels.
     *
     * The still is drawn there rather than in a box of its own: the pane the user
     * was watching is the pane the marks belong to, and the picture fits it the
     * same way the native view did, so nothing jumps as the pen takes over.
     */
    bounds: BrowserViewBounds
    /**
     * The marks drawn on this moment, which grow while the surface is open.
     *
     * A capture writes a new picture at a new path, so strokes are found by the
     * composition folder and the second rather than by the URL, and this list is
     * read from the store on every change: a stroke the user has just drawn is
     * written there and nowhere else, so a list captured when the surface opened
     * would leave them drawing on a frame that never shows their marks.
     */
    marks: ResponseReferenceAnchor[]
    /**
     * The mark whose comment is open, when the surface was opened on one.
     *
     * A composer jump names the mark it wants edited; the layer opens that mark's
     * editor once its badge is measured, which is the same path a badge clicked on
     * the picture takes.
     */
    editingId?: string | null
    /** That editor closed, so the caller can drop the request it came from. */
    onEditClosed?: () => void
    /** The pen was put down, so the caller can hand the pane back to the page. */
    onClose: () => void
    /** The user asked the picture to continue, so the caller resumes playback. */
    onContinue: () => void
  }

  let {
    projectId,
    threadId,
    snapshot,
    bounds,
    marks,
    editingId = null,
    onEditClosed = () => {},
    readOnly = false,
    onClose,
    onContinue
  }: Props = $props()

  /**
   * The still itself, as the element the keyboard returns to.
   *
   * A comment is a detour from the frame, and the press that follows one is about
   * the frame: once its editor closes, focus lands here rather than on the pen's
   * colour control, which would answer a space by opening a palette instead of
   * letting the picture continue.
   */
  let still = $state<HTMLDivElement>()

  /** The box the still is fitted inside, measured as the pane resizes. */
  let boxWidth = $state(0)
  let boxHeight = $state(0)

  /**
   * Where the picture sits inside that box.
   *
   * A mark is normalized to the picture it was drawn on, so the layer is placed on
   * the letterboxed picture rather than on the pane: a stroke normalized to the
   * pane would land off the picture in the composed frame the agent receives.
   */
  const contentBox = $derived(
    markContentBox(
      { width: boxWidth, height: boxHeight },
      { width: snapshot.width, height: snapshot.height }
    )
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

  /**
   * Store one stroke as a composer reference on this moment.
   *
   * The reference names the composition folder as well as the second, because
   * every capture of a moment writes a new picture: the folder and the moment are
   * what let the composer reopen this frame on whichever capture comes next, and
   * what let the send compose this moment's strokes onto one picture.
   */
  function createMark(capture: MarkCapture): string | null {
    const id = crypto.randomUUID()
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [
      ...current,
      {
        id,
        label: '',
        text: `${markDescriptor(snapshot.path, capture.points, {
          surface: 'frame',
          timecode: snapshot.timecode
        })}\n${detail}`,
        kind: 'image',
        mediaUrl: snapshot.url,
        directory: snapshot.directory,
        markSeconds: snapshot.seconds,
        markColor: capture.style.color,
        markStrokeWidth: capture.style.strokeWidth,
        markSurfaceEdge: capture.surfaceEdge,
        points: capture.points
      }
    ])
    // The store caps how many references a thread may hold, so a mark beyond the
    // cap never opens an editor for a reference that does not exist.
    return responseReferencesState.forThread(projectId, threadId).some((entry) => entry.id === id)
      ? id
      : null
  }
</script>

<!--
  The still takes the pane's own rectangle. The page is a native view composited
  above every DOM node, so the transport parks it while this surface is up and the
  picture main captured stands in its exact place: same rectangle, same fit, same
  frame the user was looking at.
-->
<div
  class="fixed z-40 overflow-hidden bg-black outline-none"
  style:left={`${bounds.x}px`}
  style:top={`${bounds.y}px`}
  style:width={`${bounds.width}px`}
  style:height={`${bounds.height}px`}
  bind:this={still}
  tabindex="-1"
>
  <div class="absolute inset-0" bind:offsetWidth={boxWidth} bind:offsetHeight={boxHeight}>
    <img
      class="absolute inset-0 h-full w-full object-contain"
      src={snapshot.url}
      alt={`Frame ${snapshot.timecode} of ${snapshot.directory}`}
      draggable="false"
    />
    {#if contentBox}
      <!-- The layer fills the picture rather than the pane: outside this box there
           is letterbox, and a mark belongs on the picture. -->
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
          armed={!readOnly}
          showTools={!readOnly}
          activeSeconds={snapshot.seconds}
          onArmedChange={(next) => {
            if (readOnly) return
            // The pen is this surface: putting it down is what finishes annotating,
            // and the pane goes back to the page that owns it.
            if (!next) onClose()
          }}
          {onContinue}
          onFocusSurface={() => still?.focus()}
          hint=""
        />
      </div>
    {/if}
  </div>
</div>
