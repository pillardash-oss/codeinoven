<script lang="ts">
  import AnnotationMarkLayer from './AnnotationMarkLayer.svelte'
  import VideoPlayer from '../ui/VideoPlayer.svelte'
  import { markContentBox, markDescriptor, type MarkCapture } from '$lib/annotation-marks'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import { videoTimecode } from '$shared/video/timeline'

  /**
   * The mark surface for one artifact video, drawn in the expanded viewer.
   *
   * A video the agent published is the artifact a user most often wants to answer
   * with "that moment, there", and neither a time nor a freeze frame is something
   * they should have to write out. So arming the annotator pauses the picture and
   * hands over the frame on screen: the user draws on it and writes why. Every
   * stroke is stored with the second it was drawn at, which is the whole
   * difference between this and a mark on a still, and the send composes that
   * second's frame with the strokes on it.
   *
   * A note is rarely alone. The frame strip this surface used to draw under the
   * picture was a second, invented player competing with the app's own, so the
   * player's controls are the only way to move the picture and the spacebar is
   * what lets it run again: the pen steps aside, playback continues, and the next
   * frame is annotated where the user stopped. Strokes and badges are drawn only
   * while their own frame is up, so a note about 0:05 never paints itself over
   * the 0:10 frame.
   *
   * The conversation shows the video plain. The player and the pen are all
   * decisions about the video, so this host is the lightbox
   * (`chats/MediaPreview.svelte`), which hands it the whole media area.
   *
   * The drawing itself is {@link AnnotationMarkLayer}, the same component an image
   * uses, so the pen, the numbered badges, the comment bubble and the composed
   * picture are one implementation rather than two that drift apart.
   */
  interface Props {
    projectId: string
    threadId: string
    /** The artifact's own url, which is what a mark names. */
    url: string
    /** The resolved source the player loads, which may be a scoped blob url. */
    src: string
    filename: string
    /** Where playback resumes, so a viewer opened from the inline player keeps its frame. */
    startAt?: number
    /**
     * Whether the recording was running when it was handed over.
     *
     * The inline player is stopped on the way here, because both stay mounted; the
     * viewer picks the recording up instead of leaving the user on a still frame.
     */
    autoPlay?: boolean
    /** The message the video arrived in, so a mark can be jumped back to. */
    messageId?: string
    /** Marks already drawn on this video, in composer order. */
    marks: ResponseReferenceAnchor[]
    /** A mark whose comment the user asked to edit from elsewhere. */
    editingId: string | null
    /** The comment editor closed, so the caller can clear its request. */
    onEditClosed: () => void
    /** Repair hook for a source that failed to load (a blob not ready yet). */
    onLoadError?: (element: HTMLMediaElement) => void
  }

  let {
    projectId,
    threadId,
    url,
    src,
    filename,
    startAt,
    autoPlay = false,
    messageId,
    marks,
    editingId,
    onEditClosed,
    onLoadError
  }: Props = $props()

  // Held rather than bound through `bind:this`: only `pause`, `seek` and the
  // playhead sync read the element, and turning the reference into state would
  // turn those DOM writes into state writes. The player owns it now, so it is
  // taken from the player's own hand-over.
  let video: HTMLVideoElement | null = null
  /** Whether the pointer draws on the picture instead of driving the player. */
  let armed = $state(false)
  /** Bound to the element, so a scrubbed frame and a drawn mark agree on the second. */
  let currentTime = $state(0)
  let videoWidth = $state(0)
  let videoHeight = $state(0)
  /** The player's own box, which the picture is letterboxed inside. */
  let boxWidth = $state(0)
  let boxHeight = $state(0)

  /**
   * Where the picture actually is inside the player.
   *
   * The player is given the whole media area, so its edges are not the picture's
   * edges whenever the two disagree on aspect ratio. A mark normalized to the
   * player would be drawn on the letterbox and land off the picture both in the
   * conversation and in the composed frame, so the layer is placed on this box
   * instead, and both ends of the round trip agree.
   */
  const contentBox = $derived(
    markContentBox(
      { width: boxWidth, height: boxHeight },
      { width: videoWidth, height: videoHeight }
    )
  )

  /** The second of the mark the user is editing, so its own frame can be shown. */
  const editingMarkSeconds = $derived.by(() => {
    if (!editingId) return null
    return marks.find((mark) => mark.id === editingId)?.markSeconds ?? null
  })

  $effect(() => {
    const seconds = editingMarkSeconds
    if (seconds === null || !video) return
    // A comment is about a moment, and a moment the user cannot see is not
    // editable: bring the picture to the frame the comment belongs to.
    video.currentTime = seconds
  })

  function handleArmedChange(next: boolean): void {
    armed = next
    // A moving picture cannot be drawn on: the frame the user marks has to be the
    // frame they are looking at, and it has to still be that frame when the stroke
    // lands.
    if (next) video?.pause()
  }

  function seek(seconds: number): void {
    if (!video || !Number.isFinite(seconds)) return
    video.currentTime = seconds
  }

  /**
   * Let the picture continue from an annotation.
   *
   * This is the spacebar bound to the player's own play control, and it is the
   * same press either way: running puts the pen down, because a frame that starts
   * moving is no longer the frame a stroke would land on, and stopping brings it
   * back up for the frame the user stopped on, so a pass through a recording is
   * annotate, space, annotate again rather than a round trip through the pen each
   * time. Only the element is driven here; the player keeps its own state because
   * it hears the element's own events.
   */
  function continueFromAnnotation(): void {
    const element = video
    if (!element) return
    if (element.paused) {
      handleArmedChange(false)
      void element.play().catch(() => {})
      return
    }
    element.pause()
    armed = true
  }

  function focusMark(mark: ResponseReferenceAnchor): void {
    if (mark.markSeconds === undefined) return
    seek(mark.markSeconds)
  }

  /**
   * Store one stroke as a reference on this video, at the second on screen.
   *
   * The second is captured here rather than derived at send time, because it is
   * part of what the user meant: the playhead can move afterwards, and a mark
   * whose moment followed it would be a mark on whatever frame happened to be up.
   */
  function createMark(capture: MarkCapture): string | null {
    const id = crypto.randomUUID()
    const seconds = Number.isFinite(currentTime) ? Math.max(0, currentTime) : 0
    const current = responseReferencesState.forThread(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [
      ...current,
      {
        id,
        label: '',
        text: markDescriptor(filename, capture.points, {
          surface: 'frame',
          timecode: videoTimecode(seconds)
        }),
        kind: 'image',
        mediaUrl: url,
        markSeconds: seconds,
        markColor: capture.style.color,
        markStrokeWidth: capture.style.strokeWidth,
        markSurfaceEdge: capture.surfaceEdge,
        ...(messageId ? { messageId } : {}),
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

{#snippet markOverlay()}
  <div class="absolute inset-0" bind:offsetWidth={boxWidth} bind:offsetHeight={boxHeight}>
    {#if contentBox}
      <!-- The layer fills the picture rather than the player: outside this box
           there is letterbox, and a mark belongs on the picture. -->
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
          onArmedChange={handleArmedChange}
          onFocusMark={focusMark}
          onContinue={continueFromAnnotation}
          activeSeconds={currentTime}
          hint="Draw on the frame · Space to continue · Esc to finish"
        />
      </div>
    {/if}
  </div>
{/snippet}

<div class="flex h-full min-h-0 w-full flex-col">
  <!-- The artifact video is played by the app's own player, exactly like the
       plain one in the conversation, so it shares its controls, its failure
       state and the frame it was left on. The mark layer is drawn over the
       picture: a surface that answers a video cannot also turn every press into
       play, so the player leaves the pointer to the pen here. -->
  <VideoPlayer
    {src}
    label={filename}
    {startAt}
    {autoPlay}
    fit="fill"
    interactive={false}
    showCenterControl={!armed}
    overlay={markOverlay}
    class="min-h-0 flex-1"
    onElement={(element) => (video = element)}
    onMetadata={(element) => {
      videoWidth = element.videoWidth
      videoHeight = element.videoHeight
    }}
    onTime={(seconds) => (currentTime = seconds)}
    onError={(element) => onLoadError?.(element)}
  />
</div>
