<script lang="ts">
  import { Expand } from '@lucide/svelte'
  import AnnotationMarkLayer from './AnnotationMarkLayer.svelte'
  import { markDescriptor, type MarkCapture } from '$lib/annotation-marks'
  import {
    responseReferencesState,
    type ResponseReferenceAnchor
  } from '$lib/stores/response-references.svelte'
  import { videoTimecode } from '$shared/video/timeline'

  /**
   * The mark surface for one inline artifact video.
   *
   * A video the agent published is the artifact a user most often wants to answer
   * with "that moment, there", and neither a time nor a freeze frame is something
   * they should have to write out. So arming the annotator pauses the picture and
   * hands over a frame strip: the user picks the second they mean, draws on it,
   * and writes why. Every stroke is stored with the second it was drawn at, which
   * is the whole difference between this and a mark on a still, and the send
   * composes that second's frame with the strokes on it.
   *
   * The drawing itself is {@link AnnotationMarkLayer}, the same component an image
   * uses, so the pen, the numbered badges, the comment bubble and the composed
   * picture are one implementation rather than two that drift apart.
   */
  interface Props {
    projectId: string
    threadId: string
    url: string
    filename: string
    /** The message the video arrived in, so a mark can be jumped back to. */
    messageId?: string
    /** Marks already drawn on this video, in composer order. */
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
    filename,
    messageId,
    marks,
    editingId,
    onExpand,
    onEditClosed
  }: Props = $props()

  // Deliberately not `$state`: the element reference is only ever read by the
  // playhead sync below, and making it reactive would turn that write to a DOM
  // property into a write to state.
  let video: HTMLVideoElement | null = null
  /** Whether the pointer draws on the picture instead of driving the player. */
  let armed = $state(false)
  /** Bound to the element, so a scrubbed frame and a drawn mark agree on the second. */
  let currentTime = $state(0)
  let duration = $state(0)
  let videoWidth = $state(0)
  let videoHeight = $state(0)
  /** The video element's own box, which the picture is letterboxed inside. */
  let boxWidth = $state(0)
  let boxHeight = $state(0)

  /**
   * Where the picture actually is inside the video element.
   *
   * A video keeps its own aspect ratio inside whatever box it is given, so the
   * element's edges are not the picture's edges whenever the two disagree. A mark
   * normalized to the element would be drawn on the letterbox and land off the
   * picture both in the conversation and in the composed frame, so the layer is
   * placed on this box instead, and both ends of the round trip agree.
   */
  const contentBox = $derived.by(() => {
    if (boxWidth <= 0 || boxHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return null
    const fit = Math.min(boxWidth / videoWidth, boxHeight / videoHeight)
    const width = videoWidth * fit
    const height = videoHeight * fit
    return {
      height,
      left: (boxWidth - width) / 2,
      top: (boxHeight - height) / 2,
      width
    }
  })

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

<figure class="w-full min-w-0 overflow-hidden rounded-lg border border-border bg-surface">
  <figcaption class="flex items-center justify-between gap-2 px-3 py-2 text-xs text-muted">
    <span class="truncate">{filename}</span>
    <button
      type="button"
      class="shrink-0 rounded p-1 text-muted hover:bg-elevated hover:text-foreground"
      title={`Expand ${filename}`}
      aria-label={`Expand ${filename}`}
      onclick={onExpand}><Expand size={14} /></button
    >
  </figcaption>
  <div class="relative" bind:offsetWidth={boxWidth} bind:offsetHeight={boxHeight}>
    <video
      bind:this={video}
      class="block max-h-96 w-full"
      src={url}
      controls={!armed}
      preload="metadata"
      playsinline
      bind:currentTime
      bind:duration
      bind:videoWidth
      bind:videoHeight
    >
      <track kind="captions" />
    </video>
    {#if contentBox}
      <!-- The layer fills the picture rather than the element: outside this box
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
          activeSeconds={currentTime}
          badgeVisibility="while-annotating"
          hint="Pick the frame, then draw · Esc to finish"
        />
      </div>
    {/if}
  </div>
  {#if armed}
    <div class="flex items-center gap-2 border-t border-border px-3 py-2">
      <span class="shrink-0 font-mono text-xs text-muted">{videoTimecode(currentTime)}</span>
      <input
        type="range"
        class="min-w-0 flex-1"
        min="0"
        max={duration > 0 ? duration : 0}
        step="0.01"
        value={currentTime}
        title="The frame the next mark is drawn on"
        aria-label="Frame to annotate"
        oninput={(event) => seek(Number(event.currentTarget.value))}
      />
      <span class="shrink-0 text-xs text-muted">Frame {Math.round(currentTime * 1000)}ms</span>
    </div>
  {/if}
</figure>
