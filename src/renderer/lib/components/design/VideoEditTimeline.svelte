<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte'
  import { on } from 'svelte/events'
  import { ContextMenu } from 'bits-ui'
  import { createAttachmentKey } from 'svelte/attachments'
  import { browserVisibility, trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'
  import StudioSidebarResizeHandle from '$lib/components/specs/StudioSidebarResizeHandle.svelte'
  import SeekBar from '$lib/components/ui/SeekBar.svelte'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioCaptions from '@pdslng/cio-icon/CioCaptions.svelte'
  import CioLayers from '@pdslng/cio-icon/CioLayers.svelte'
  import type { VideoEditTrack } from '$shared/video/edit'
  import CioGrip from '@pdslng/cio-icon/CioGrip.svelte'
  import CioLockOpen from '@pdslng/cio-icon/CioLockOpen.svelte'
  import CioEyeOff from '@pdslng/cio-icon/CioEyeOff.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import CioFrame from '@pdslng/cio-icon/CioFrame.svelte'
  import CioZoomIn from '@pdslng/cio-icon/CioZoomIn.svelte'
  import CioZoomOut from '@pdslng/cio-icon/CioZoomOut.svelte'
  import type { VideoEditorController } from '$lib/stores/video-editor.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'
  import { videoNoteFocusState } from '$lib/stores/video-note-focus.svelte'
  import ResponseAnnotationComment from '$lib/components/chats/ResponseAnnotationComment.svelte'
  import {
    mediaMarkChatContext,
    openAnnotationChat,
    videoMomentChatContext
  } from '$lib/annotation-chat'
  import type { VideoEditChange } from '$shared/video/edit'
  import { snapEditTime, videoTrackHasAudio } from '$shared/video/edit'
  import { videoTimecode } from '$shared/video/timeline'
  import { visibleClipFrames, videoThumbnailClips } from '$shared/video/frame-grid'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { newVideoNoteId, videoNoteReference } from '$lib/video-note-reference'
  import {
    clusterTimelineMarks,
    timelineComments,
    type TimelineCluster,
    type TimelineComment
  } from './VideoEditTimeline/timeline-lanes'

  let {
    editor,
    tools,
    addTrack,
    contextActions
  }: {
    editor: VideoEditorController
    tools?: Snippet
    /**
     * The Add track control, which lives in the gutter.
     *
     * A row's name belongs over the rows it names, so the control that adds a row
     * sits there rather than in the middle of the toolbar, and the rest of the
     * toolbar starts where the track names do.
     */
    addTrack?: Snippet
    contextActions?: Snippet
  } = $props()
  const trackTypes = {
    video: { icon: CioClapper, label: 'Video' },
    audio: { icon: CioAudioLines, label: 'Audio' },
    caption: { icon: CioCaptions, label: 'Captions' },
    overlay: { icon: CioLayers, label: 'Overlays' }
  }
  /**
   * The two lanes under the tracks: the comments written on this composition and
   * the edits the agent made to it.
   *
   * They are rows in the same rhythm as a track, with their own remembered
   * height, because they sit in both columns: the label column names the lane and
   * the content column draws its markers, and both read the height from the one
   * place so the two halves cannot drift apart.
   */
  const AGENT_ROW = 'agent-edits'
  const COMMENTS_ROW = 'comments'
  const LANE_HEIGHT = 34
  const LANE_MIN_HEIGHT = 24
  const LANE_MAX_HEIGHT = 120
  /** Marker widths, which are also the gap under which two marks read as one. */
  const AGENT_MARKER_WIDTH = 16
  const COMMENT_MARKER_WIDTH = 26
  let labelWidth = $state(208)
  let rowHeights = $state<Record<string, number>>({})
  let contextTrack = $state('')
  let draggedTrack = ''
  let hoverTime = $state<number | null>(null)
  const occlusion = { [createAttachmentKey()]: trackBrowserOcclusion }
  const stageContext = {
    [createAttachmentKey()]: (element: HTMLElement) => {
      const request = editor.contextRequest
      if (!request) return
      queueMicrotask(() => {
        const bounds = browserVisibility.pageBoundsFor(editor.tabId)
        if (!bounds) return
        element.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: bounds.x + request.x * bounds.width,
            clientY: bounds.y + request.y * bounds.height
          })
        )
        if (editor.contextRequest === request) editor.contextRequest = null
      })
    }
  }
  const trackHeight = (id: string): number => rowHeights[id] ?? 64
  const laneHeight = (id: string): number => rowHeights[id] ?? LANE_HEIGHT
  const isLane = (id: string): boolean => id === AGENT_ROW || id === COMMENTS_ROW
  function rememberRows(): void {
    localStorage.setItem('cio:video-editor-tracks', JSON.stringify({ labelWidth, rowHeights }))
  }
  onMount(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('cio:video-editor-tracks') ?? 'null')
      if (!raw || typeof raw !== 'object') return
      const saved = raw as Record<string, unknown>
      if (typeof saved.labelWidth === 'number' && Number.isFinite(saved.labelWidth))
        labelWidth = Math.max(112, Math.min(320, saved.labelWidth))
      if (saved.rowHeights && typeof saved.rowHeights === 'object')
        rowHeights = Object.fromEntries(
          Object.entries(saved.rowHeights)
            .slice(0, 32)
            .filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1])
            )
            .map(([key, height]) => [
              key,
              isLane(key)
                ? Math.max(LANE_MIN_HEIGHT, Math.min(LANE_MAX_HEIGHT, height))
                : Math.max(40, Math.min(220, height))
            ])
        )
    } catch {
      /* Invalid preferences do not block editing. */
    }
  })
  function reorderTrack(id: string, targetId: string): void {
    editor.mutate((_doc, edit) => {
      const from = edit.tracks.findIndex((item) => item.id === id)
      const to = edit.tracks.findIndex((item) => item.id === targetId)
      if (from < 0 || to < 0 || from === to) return
      const [track] = edit.tracks.splice(from, 1)
      edit.tracks.splice(to, 0, track)
    })
  }
  function shiftTrack(direction: number): void {
    const tracks = editor.edit?.tracks ?? []
    const index = tracks.findIndex((track) => track.id === contextTrack)
    if (tracks[index + direction]) reorderTrack(contextTrack, tracks[index + direction].id)
  }
  let viewport: HTMLDivElement | undefined
  let width = $state(500)
  let scrollLeft = $state(0)
  let zoom = $state(1)
  const pixelsPerSecond = $derived(Math.max(0.1, (width - 8) / Math.max(1, editor.duration)) * zoom)
  const contentWidth = $derived(
    Math.min(180000, Math.max(width, editor.duration * pixelsPerSecond))
  )
  const scale = $derived(contentWidth / editor.duration)
  const start = $derived(scrollLeft / scale)
  const end = $derived((scrollLeft + width) / scale)
  const frameCells = $derived(
    visibleClipFrames(videoThumbnailClips(editor.document), editor.fps, start, end, scale)
  )
  /**
   * The agent's edits on this composition, in time order.
   *
   * One marker per edit reads as one marker per edit only while the edits are far
   * apart: a burst sits inside a few pixels at the fit zoom, so marks that would
   * overlap are folded into one badge that carries their count. Every cluster
   * keeps the span it covers, which is what the lane underlines.
   */
  const agentEdits = $derived(
    (editor.edit?.changes ?? [])
      .filter((change) => change.author === 'agent')
      .slice(-200)
      .sort((left, right) => left.start - right.start)
  )
  const agentPending = $derived(agentEdits.filter((change) => !change.reviewed).length)
  const agentClusters = $derived(
    clusterTimelineMarks(
      agentEdits,
      (change) => change.start * scale,
      (change) => change.id,
      AGENT_MARKER_WIDTH
    ).map((cluster) => {
      const pending = cluster.items.filter((change) => !change.reviewed).length
      return {
        key: cluster.key,
        x: cluster.x,
        items: cluster.items,
        pending,
        from: cluster.items[0].start,
        to: Math.max(...cluster.items.map((change) => change.end))
      }
    })
  )
  /**
   * Every comment on this composition, from any of the three ways to write one:
   * a note on the moment, a note on the selected clip, and a stroke drawn on a
   * frame with the annotation tool.
   *
   * Each keeps the number it has in the conversation's reference list, which is
   * the number its composer chip and the model use, so a comment pinned here and
   * a chip in the composer name the same thing.
   */
  const comments = $derived(
    timelineComments(
      responseReferencesState.forThread(editor.projectId, editor.threadId),
      editor.directory
    )
  )
  const commentClusters = $derived(
    clusterTimelineMarks(
      comments,
      (comment) => comment.seconds * scale,
      (comment) => comment.reference.id,
      COMMENT_MARKER_WIDTH
    )
  )
  const visibleClips = $derived.by(() => {
    const items =
      editor.edit?.clips.filter(
        (clip) => clip.start + clip.duration >= start && clip.start <= end
      ) ?? []
    const stride = Math.max(1, Math.ceil(items.length / 500))
    return items.filter((clip, index) => index % stride === 0 || editor.isClipSelected(clip.id))
  })
  const visibleCaptions = $derived.by(() => {
    const items: {
      caption: NonNullable<typeof editor.document>['captions'][number]
      index: number
    }[] = []
    for (const [index, caption] of (editor.document?.captions ?? []).entries())
      if (caption.end >= start && caption.start <= end) items.push({ caption, index })
    const stride = Math.max(1, Math.ceil(items.length / 300))
    return items.filter(
      (item, index) =>
        index % stride === 0 ||
        (editor.selection?.kind === 'caption' && editor.selection.index === item.index)
    )
  })
  const tickStep = $derived(
    [1 / editor.fps, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 600].find((step) => step * scale >= 65) ?? 600
  )
  const ticks = $derived(
    Array.from(
      { length: Math.min(80, Math.ceil((end - start) / tickStep) + 2) },
      (_, index) => (Math.floor(start / tickStep) + index) * tickStep
    ).filter((time) => time <= editor.duration)
  )
  let drag: {
    kind: 'clip' | 'caption' | 'region'
    id: string
    index: number
    x: number
    scale: number
    start: number
    end: number
    edge: 'start' | 'end' | null
    trackId: string
  } | null = null
  let releaseDrag: (() => void) | undefined
  function captureDrag(event: PointerEvent): void {
    releaseDrag?.()
    const target = event.currentTarget as HTMLElement
    const pointerId = event.pointerId
    target.setPointerCapture(pointerId)
    const offMove = on(window, 'pointermove', (next) => {
      if (next.pointerId === pointerId) move(next)
    })
    const offUp = on(window, 'pointerup', (next) => {
      if (next.pointerId === pointerId) finish(next)
    })
    const offCancel = on(window, 'pointercancel', (next) => {
      if (next.pointerId === pointerId) finish(next, true)
    })
    releaseDrag = () => {
      offMove()
      offUp()
      offCancel()
      if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
      releaseDrag = undefined
    }
  }
  onMount(() => () => {
    if (drag) editor.finishGesture(true)
    releaseDrag?.()
  })
  let scrubbing = false
  let gestureZoom = 1
  async function zoomAt(next: number, clientX?: number): Promise<void> {
    if (!viewport) return
    const offset =
      clientX === undefined
        ? width / 2
        : Math.max(
            0,
            Math.min(width, clientX - viewport.getBoundingClientRect().left - labelWidth - 6)
          )
    const anchor = (viewport.scrollLeft + offset) / scale
    zoom = Math.max(1, Math.min(1000, next))
    await tick()
    if (viewport) viewport.scrollLeft = Math.max(0, anchor * scale - offset)
    editor.requestFrames(start, end, contentWidth)
  }
  function wheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    void zoomAt(
      zoom * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.08 : 0.008)),
      event.clientX
    )
  }

  function at(event: { clientX: number }): number {
    if (!viewport) return 0
    return snapEditTime(
      (event.clientX -
        viewport.getBoundingClientRect().left -
        labelWidth -
        6 +
        viewport.scrollLeft) /
        scale,
      editor.fps
    )
  }
  function startClip(event: PointerEvent, id: string): void {
    if (event.button !== 0) return
    const clip = editor.edit?.clips.find((clip) => clip.id === id)
    if (!clip || editor.edit?.tracks.find((track) => track.id === clip.trackId)?.locked) return
    event.preventDefault()
    event.stopPropagation()
    const target =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-trim]') : null
    const edge =
      target?.dataset.trim === 'start' ? 'start' : target?.dataset.trim === 'end' ? 'end' : null
    // Shift extends from the last clicked clip, mod toggles one in or out, and a
    // plain press replaces the set. A modifier press never starts a drag, so the
    // gesture cannot move a clip the user only meant to add to the selection.
    if (!edge && (event.shiftKey || event.metaKey || event.ctrlKey)) {
      editor.selectClip(id, event.shiftKey ? 'range' : 'toggle')
      return
    }
    drag = {
      kind: 'clip',
      id,
      index: -1,
      x: event.clientX,
      scale,
      start: clip.start,
      end: clip.start + clip.duration,
      edge,
      trackId: clip.trackId
    }
    editor.selectClip(id)
    editor.beginGesture()
    captureDrag(event)
  }
  function startBand(
    event: PointerEvent,
    kind: 'caption' | 'region',
    id: string,
    index: number,
    from: number,
    to: number
  ): void {
    if (event.button !== 0) return
    const item =
      kind === 'caption'
        ? editor.document?.captions[index]
        : editor.edit?.regions.find((item) => item.id === id)
    if (editor.edit?.tracks.find((track) => track.id === item?.trackId)?.locked) return
    event.preventDefault()
    event.stopPropagation()
    const target =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-trim]') : null
    const edge =
      target?.dataset.trim === 'start' ? 'start' : target?.dataset.trim === 'end' ? 'end' : null
    drag = { kind, id, index, x: event.clientX, scale, start: from, end: to, edge, trackId: '' }
    editor.select(kind === 'caption' ? { kind, index } : { kind, id })
    editor.beginGesture()
    captureDrag(event)
  }
  function move(event: PointerEvent): void {
    if (!drag) return
    const active = drag,
      delta = (event.clientX - active.x) / active.scale
    if (active.kind === 'clip') {
      if (active.edge)
        editor.trimClip(
          active.id,
          active.edge,
          (active.edge === 'start' ? active.start : active.end) + delta
        )
      else {
        const track =
          document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>('[data-video-track]')?.dataset.videoTrack ?? active.trackId
        const source = editor.edit?.tracks.find((item) => item.id === active.trackId)
        const destination = editor.edit?.tracks.find((item) => item.id === track)
        editor.moveClip(
          active.id,
          active.start + delta,
          destination && !destination.locked && destination.kind === source?.kind
            ? track
            : active.trackId
        )
      }
    } else
      editor.updateGesture((doc, edit) => {
        const previousEnd =
          active.kind === 'caption' ? (doc.captions[active.index - 1]?.end ?? 0) : 0
        const nextStart =
          active.kind === 'caption'
            ? (doc.captions[active.index + 1]?.start ?? edit.duration)
            : edit.duration
        let from = active.start,
          to = active.end
        if (active.edge === 'start')
          from = Math.max(
            previousEnd,
            Math.min(to - 1 / editor.fps, snapEditTime(from + delta, editor.fps))
          )
        else if (active.edge === 'end')
          to = Math.min(
            nextStart,
            Math.max(from + 1 / editor.fps, snapEditTime(to + delta, editor.fps))
          )
        else {
          from = Math.max(
            previousEnd,
            Math.min(nextStart - (to - from), snapEditTime(from + delta, editor.fps))
          )
          to = from + active.end - active.start
        }
        if (active.kind === 'caption') {
          const caption = doc.captions[active.index]
          caption.start = from
          caption.end = to
          if (caption.words)
            caption.words = caption.words
              .map((word) => ({
                ...word,
                start: word.start + (active.edge ? 0 : from - active.start),
                end: word.end + (active.edge ? 0 : from - active.start)
              }))
              .filter((word) => word.start >= from && word.end <= to)
        } else {
          const region = edit.regions.find((region) => region.id === active.id)
          if (region) {
            region.start = from
            region.duration = to - from
          }
        }
      })
  }
  function finish(event: PointerEvent, cancel = false): void {
    if (!drag) return
    drag = null
    editor.finishGesture(cancel)
    releaseDrag?.()
  }
  function seekStart(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    scrubbing = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    editor.seek(at(event))
  }
  function drop(event: DragEvent, trackId: string): void {
    event.preventDefault()
    event.stopPropagation()
    const assetId = event.dataTransfer?.getData('application/x-cio-video-asset')
    if (assetId) editor.addAsset(assetId, at(event), trackId)
    else if (event.dataTransfer?.files.length)
      void editor.dropFiles(Array.from(event.dataTransfer.files), at(event), trackId)
  }
  function toggleTrack(id: string, key: 'locked' | 'muted' | 'hidden'): void {
    editor.setTrackFlag(id, key)
  }
  /**
   * Whether this track can be heard, which is what earns it a speaker and a level.
   *
   * A video track whose media carries sound can, a silent overlay cannot, and an
   * overlay gains both the moment a sound effect is dropped on it.
   */
  function trackIsAudible(track: VideoEditTrack): boolean {
    const edit = editor.edit
    return edit ? videoTrackHasAudio(edit, track.id) : false
  }
  /**
   * The fader's name, which has to say which track it belongs to.
   *
   * Track names are free text and two tracks can share one, so the row's position
   * is what makes the label unique for a screen reader and for a person reading
   * the slider's own tooltip.
   */
  function trackLevelLabel(track: VideoEditTrack): string {
    const order = (editor.edit?.tracks ?? []).findIndex((item) => item.id === track.id) + 1
    return `${track.name} track ${order} level, ${Math.round(track.volume * 100)}%`
  }
  function setTrackLevel(id: string, volume: number): void {
    editor.setTrackVolume(id, volume)
  }

  /** What a cluster of agent edits says about itself, in one sentence. */
  function agentClusterLabel(cluster: { items: VideoEditChange[]; pending: number }): string {
    const first = cluster.items[0]
    const state =
      cluster.pending === 0
        ? 'all reviewed'
        : `${cluster.pending} of ${cluster.items.length} still to review`
    if (cluster.items.length === 1)
      return `${first.reviewed ? 'Agent edit reviewed' : 'Agent edit to review'}: ${first.label} at ${videoTimecode(first.start)}`
    return `${cluster.items.length} agent edits, ${state}, starting at ${videoTimecode(first.start)} with ${first.label}`
  }

  /** What one comment is called wherever the timeline names it. */
  function commentLabel(comment: TimelineComment): string {
    const text = (comment.reference.comment ?? '').trim()
    const kind = comment.annotation ? 'Frame annotation' : 'Video note'
    return `${kind} ${comment.number} at ${videoTimecode(comment.seconds)}${text ? `: ${text}` : ''}`
  }

  /** A cluster of comments, named by the one the reader would land on. */
  function commentClusterLabel(cluster: TimelineCluster<TimelineComment>): string {
    if (cluster.items.length === 1) return commentLabel(cluster.items[0])
    return `${cluster.items.length} comments at this moment, starting with ${commentLabel(cluster.items[0])}`
  }

  /**
   * The open comment and where its bubble is anchored.
   *
   * A comment is read and written in the one comment bubble the app draws, the
   * same one the composer's jump opens, so the lane only has to name the comment
   * and the point on screen it belongs to.
   */
  let commentEditor = $state<{ id: string; x: number; y: number } | null>(null)
  /**
   * What had the keyboard before the comment bubble took it.
   *
   * A comment is typed in a bubble over the timeline, so while it is open the
   * bubble owns the keyboard. When it closes, the editor has to be the surface
   * being typed at again: space over a video is play and pause, and a focus left on
   * nothing means the editor never hears the next press.
   */
  let commentReturnFocus: HTMLElement | null = null
  const editingComment = $derived(
    commentEditor
      ? (comments.find((comment) => comment.reference.id === commentEditor?.id) ?? null)
      : null
  )
  const editingCommentId = $derived(editingComment?.reference.id ?? '')
  /** Remember the surface the bubble is taking the keyboard from. */
  function rememberCommentFocus(): void {
    const focused = document.activeElement
    commentReturnFocus =
      focused instanceof HTMLElement && focused !== document.body ? focused : (viewport ?? null)
  }

  /** Give the keyboard back to the timeline once the bubble closes. */
  function restoreTimelineFocus(): void {
    const remembered = commentReturnFocus
    commentReturnFocus = null
    // The bubble is still in the tree while this runs, so the handover waits for
    // the frame that removes it: a caret placed now would be undone by the
    // unmounting bubble's own teardown.
    setTimeout(() => {
      const target = remembered?.isConnected ? remembered : viewport
      window.focus()
      target?.focus({ preventScroll: true })
    }, 0)
  }

  /** Seek to a comment and read it, which is what clicking its marker means. */
  function openComment(event: MouseEvent, comment: TimelineComment): void {
    editor.seek(comment.seconds)
    const marker = event.currentTarget
    if (!(marker instanceof HTMLElement)) return
    rememberCommentFocus()
    const bounds = marker.getBoundingClientRect()
    commentEditor = {
      id: comment.reference.id,
      x: bounds.left + bounds.width / 2,
      y: bounds.bottom
    }
  }
  /**
   * Close the bubble, dropping a comment the user left blank.
   *
   * The bubble is opened before the comment is written, so a comment opened and
   * then dismissed without a word is not a note: it would sit on the lane as an
   * empty marker the reader has to open to find out it says nothing.
   */
  function closeComment(): void {
    const current = commentEditor
    commentEditor = null
    restoreTimelineFocus()
    if (!current) return
    const note = responseReferencesState
      .forThread(editor.projectId, editor.threadId)
      .find((reference) => reference.id === current.id)
    if (note && (note.comment ?? '').trim() === '') removeReference(current.id)
  }

  function removeReference(id: string): void {
    const existing = responseReferencesState.forThread(editor.projectId, editor.threadId)
    if (!existing.some((reference) => reference.id === id)) return
    responseReferencesState.setForThread(
      editor.projectId,
      editor.threadId,
      existing.filter((reference) => reference.id !== id)
    )
  }
  function draftComment(comment: string): void {
    const current = editingComment
    if (!current) return
    responseReferencesState.updateCommentDraft(
      editor.projectId,
      editor.threadId,
      current.reference.id,
      comment
    )
  }
  function saveComment(comment: string): void {
    const current = editingComment
    commentEditor = null
    restoreTimelineFocus()
    if (!current) return
    responseReferencesState.updateComment(
      editor.projectId,
      editor.threadId,
      current.reference.id,
      comment
    )
  }
  function removeComment(): void {
    const current = editingComment
    commentEditor = null
    restoreTimelineFocus()
    if (!current) return
    removeReference(current.reference.id)
  }

  /**
   * Comment on the selected item, from the item itself.
   *
   * A comment on a moment names a second; a comment on an item names the clip the
   * reader picked, so it is written at the playhead when the playhead is already
   * inside that clip and at the clip's own first frame otherwise. Either way it is
   * the same note the other two routes write, so it lands on the comments lane and
   * on the clip's own row, and the model reads it as a comment on this moment of
   * this composition.
   */
  async function commentOnSelection(): Promise<void> {
    const clip = editor.selectedClip
    if (!clip) return
    const inside = editor.time >= clip.start && editor.time < clip.start + clip.duration
    const seconds = inside ? editor.time : clip.start
    const id = newVideoNoteId()
    const existing = responseReferencesState.forThread(editor.projectId, editor.threadId)
    rememberCommentFocus()
    responseReferencesState.setForThread(editor.projectId, editor.threadId, [
      ...existing,
      {
        ...videoNoteReference(id, seconds, {
          directory: editor.directory,
          composition: { fps: editor.fps, duration: editor.duration },
          document: editor.document,
          ...(editor.tabId ? { tabId: editor.tabId } : {})
        }),
        comment: ''
      }
    ])
    editor.seek(seconds)
    await tick()
    const marker = commentMarker(id)
    if (!marker) return
    marker.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    const bounds = marker.getBoundingClientRect()
    commentEditor = { id, x: bounds.left + bounds.width / 2, y: bounds.bottom }
  }
  /** The marker drawn for one comment, so a jump can anchor to it. */
  function commentMarker(id: string): HTMLElement | null {
    const markers = viewport?.querySelectorAll<HTMLElement>('[data-video-comments]')
    if (!markers) return null
    for (const marker of markers)
      if ((marker.dataset.videoComments ?? '').split(' ').includes(id)) return marker
    return null
  }
  /**
   * A jump from the composer names the comment it wants opened.
   *
   * This timeline is the surface that draws a composition's comments, so it takes
   * the request the way the board's own timeline did: seek to the comment, bring
   * its marker into view and open it, so a chip in the conversation lands on the
   * row it names rather than on the composition's first frame.
   */
  $effect(() => {
    const request = videoNoteFocusState.pending(editor.projectId, editor.threadId)
    if (!request || request.directory !== editor.directory) return
    const comment = comments.find((entry) => entry.reference.id === request.referenceId) ?? null
    videoNoteFocusState.consume(request.token)
    editor.seek(request.seconds)
    if (!comment) return
    const marker = commentMarker(comment.reference.id)
    if (!marker) return
    marker.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    rememberCommentFocus()
    const bounds = marker.getBoundingClientRect()
    commentEditor = {
      id: comment.reference.id,
      x: bounds.left + bounds.width / 2,
      y: bounds.bottom
    }
  })
  /** Ask about the moment or the annotated frame, in the read-only side chat. */
  function chatAboutComment(mode: 'elaborate' | 'quick'): void {
    const current = editingComment
    commentEditor = null
    commentReturnFocus = null
    if (!current) return
    openAnnotationChat({
      projectId: editor.projectId,
      threadId: editor.threadId,
      mode,
      selection: current.reference.text,
      context: current.annotation
        ? mediaMarkChatContext('video frame')
        : videoMomentChatContext(editor.directory)
    })
  }
</script>

{#snippet captionItems(track: VideoEditTrack)}
  {#each visibleCaptions.filter(({ caption }) => caption.trackId === track.id) as { caption, index } (index)}
    {#if caption.end >= start && caption.start <= end}
      <button
        type="button"
        class={[
          'absolute top-1 touch-none overflow-hidden border px-2 text-left text-[0.5625rem]',
          editor.selection?.kind === 'caption' && editor.selection.index === index
            ? 'border-primary bg-primary/25 text-foreground ring-2 ring-primary ring-inset'
            : 'border-warning/30 bg-warning/10 text-foreground'
        ]}
        style:left={`${caption.start * scale}px`}
        style:width={`${Math.max(4, (caption.end - caption.start) * scale)}px`}
        title={`${caption.text} · drag to move or trim`}
        aria-label={`Caption: ${caption.text}`}
        data-video-caption={index}
        aria-pressed={editor.selection?.kind === 'caption' && editor.selection.index === index}
        style:height={`${trackHeight(track.id) - 12}px`}
        onpointerdown={(event) =>
          startBand(event, 'caption', '', index, caption.start, caption.end)}
        onclick={() => editor.select({ kind: 'caption', index }, caption.start)}
      >
        <span class="absolute inset-y-0 left-0 w-1 cursor-ew-resize bg-warning/30" data-trim="start"
        ></span><span class="pointer-events-none whitespace-nowrap">{caption.text}</span><span
          class="absolute inset-y-0 right-0 w-1 cursor-ew-resize bg-warning/30"
          data-trim="end"
        ></span>
      </button>
    {/if}
  {/each}
{/snippet}
{#snippet overlayItems(track: VideoEditTrack)}
  {#each (editor.edit?.regions ?? []).filter((region) => region.trackId === track.id) as region (region.id)}
    {#if region.start + region.duration >= start && region.start <= end}
      <button
        type="button"
        class={[
          'absolute top-1 touch-none overflow-hidden border px-2 text-left text-[0.5625rem]',
          editor.selection?.kind === 'region' && editor.selection.id === region.id
            ? 'border-primary bg-primary/25 text-foreground ring-2 ring-primary ring-inset'
            : 'border-danger/30 bg-danger/10 text-foreground'
        ]}
        style:left={`${region.start * scale}px`}
        style:width={`${Math.max(4, region.duration * scale)}px`}
        title={`${region.kind} · drag to move or trim`}
        aria-label={`${region.kind} region at ${videoTimecode(region.start)}`}
        data-video-region={region.id}
        aria-pressed={editor.selection?.kind === 'region' && editor.selection.id === region.id}
        style:height={`${trackHeight(track.id) - 12}px`}
        onpointerdown={(event) =>
          startBand(event, 'region', region.id, -1, region.start, region.start + region.duration)}
        onclick={() => editor.select({ kind: 'region', id: region.id }, region.start)}
      >
        <span class="absolute inset-y-0 left-0 w-1 cursor-ew-resize bg-danger/30" data-trim="start"
        ></span><span class="pointer-events-none">{region.kind}</span><span
          class="absolute inset-y-0 right-0 w-1 cursor-ew-resize bg-danger/30"
          data-trim="end"
        ></span>
      </button>
    {/if}
  {/each}
{/snippet}
<ContextMenu.Root>
  <ContextMenu.Trigger
    {...stageContext}
    class="flex min-h-0 flex-1 flex-col"
    data-drop-region="video-editor"
    oncontextmenu={(event) => {
      const element = event.target instanceof Element ? event.target : null
      const id = element?.closest<HTMLElement>('[data-video-clip]')?.dataset.videoClip
      contextTrack = element?.closest<HTMLElement>('[data-video-track]')?.dataset.videoTrack ?? ''
      if (id) editor.select({ kind: 'clip', id })
      const caption = element?.closest<HTMLElement>('[data-video-caption]')?.dataset.videoCaption
      const region = element?.closest<HTMLElement>('[data-video-region]')?.dataset.videoRegion
      if (caption !== undefined) editor.select({ kind: 'caption', index: Number(caption) })
      else if (region) editor.select({ kind: 'region', id: region })
    }}
  >
    <div
      class="flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-surface py-1 text-[0.6875rem] text-muted"
    >
      <div class="shrink-0 px-1" style:width={`${labelWidth + 6}px`}>{@render addTrack?.()}</div>
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1 pr-2">
        {@render tools?.()}
        <div class="min-w-2 flex-1"></div>
        <!--
          The zoom controls are the same size as every other icon in this row:
          the text steppers used to sit shorter and narrower than their siblings.
          The level between them is the step the timeline is on right now.
        -->
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          title="Fit the whole timeline"
          aria-label="Fit the whole timeline"
          onclick={() => void zoomAt(1)}><CioFrame size={13} /></button
        >
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          title="Zoom out of the timeline"
          aria-label="Zoom out of the timeline"
          disabled={zoom <= 1}
          onclick={() => void zoomAt(zoom / 1.5)}><CioZoomOut size={13} /></button
        >
        <span
          class="w-11 shrink-0 text-center font-mono text-xs tabular-nums text-muted"
          title="Timeline zoom level"
          aria-label={`Timeline zoom ${Math.round(zoom * 100)} percent`}
          >{Math.round(zoom * 100)}%</span
        >
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          title="Zoom into the timeline"
          aria-label="Zoom into the timeline"
          disabled={contentWidth >= 180000}
          onclick={() => void zoomAt(zoom * 1.5)}><CioZoomIn size={13} /></button
        >
      </div>
    </div>
    <div
      {@attach (element) => {
        viewport = element
        width = Math.max(1, element.clientWidth - labelWidth - 6)
        const observer = new ResizeObserver(() => {
          width = Math.max(1, element.clientWidth - labelWidth - 6)
          queueMicrotask(() => editor.requestFrames(start, end, contentWidth))
        })
        observer.observe(element)
        const offWheel = on(element, 'wheel', wheel, { passive: false })
        const gestureStart = (event: Event): void => {
          event.preventDefault()
          gestureZoom = zoom
        }
        const gestureChange = (event: Event): void => {
          event.preventDefault()
          const gesture = event as Event & { scale: number; clientX: number }
          if (Number.isFinite(gesture.scale))
            void zoomAt(gestureZoom * gesture.scale, gesture.clientX)
        }
        element.addEventListener('gesturestart', gestureStart, { passive: false })
        element.addEventListener('gesturechange', gestureChange, { passive: false })
        return () => {
          observer.disconnect()
          offWheel()
          element.removeEventListener('gesturestart', gestureStart)
          element.removeEventListener('gesturechange', gestureChange)
          if (viewport === element) viewport = undefined
        }
      }}
      class="flex min-h-0 flex-1 overflow-auto"
      tabindex="-1"
      aria-label="Timeline tracks"
      onscroll={(event) => {
        scrollLeft = event.currentTarget.scrollLeft
        editor.requestFrames(start, end, contentWidth)
      }}
    >
      <div
        class="sticky left-0 z-20 shrink-0 self-start border-r border-border bg-surface"
        style:width={`${labelWidth}px`}
      >
        <div
          class="sticky top-0 z-30 flex h-6 items-center border-b border-border bg-surface px-2 text-[0.625rem] uppercase tracking-wide text-dimmed"
        >
          Timeline
        </div>
        {#each editor.edit?.tracks ?? [] as track (track.id)}
          {@const type = trackTypes[track.kind]}
          <div
            class="relative flex items-center gap-1 border-b border-border px-1"
            style:height={`${trackHeight(track.id)}px`}
            data-video-track={track.id}
            role="group"
            aria-label={`${track.name} track controls`}
            ondragover={(event) => {
              if (draggedTrack) event.preventDefault()
            }}
            ondrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              reorderTrack(draggedTrack, track.id)
              draggedTrack = ''
            }}
            ondragend={() => (draggedTrack = '')}
          >
            <button
              type="button"
              draggable="true"
              class="shrink-0 cursor-grab px-1 text-dimmed hover:text-foreground"
              title={`Drag to reorder ${track.name}`}
              aria-label={`Reorder ${track.name}`}
              ondragstart={(event) => {
                draggedTrack = track.id
                event.dataTransfer?.setData('application/x-cio-video-track', track.id)
              }}
              ondragend={() => (draggedTrack = '')}><CioGrip size={12} /></button
            >
            <div class="min-w-0 flex-1">
              <input
                class="w-full min-w-0 bg-transparent text-[0.625rem] outline-none focus:bg-elevated"
                value={track.name}
                aria-label="Track name"
                title={`Rename ${track.name}`}
                onchange={(event) =>
                  editor.mutate((_doc, edit) => {
                    const target = edit.tracks.find((item) => item.id === track.id)
                    if (target) target.name = event.currentTarget.value
                  })}
              />
              <div class="flex items-center gap-1 text-[0.5625rem] text-dimmed">
                <type.icon size={12} /><span>{type.label}</span>
                {#if trackIsAudible(track)}
                  <span class="ml-auto shrink-0 tabular-nums text-muted"
                    >{Math.round(track.volume * 100)}%</span
                  >
                {/if}
              </div>
              {#if trackIsAudible(track)}
                <!--
                  The track's own fader. A person mixes a track, not a clip: speech
                  up and music down is one drag each, and the drag is one undo step.
                -->
                <SeekBar
                  value={track.volume}
                  min={0}
                  max={2}
                  step={0.01}
                  label={trackLevelLabel(track)}
                  title={trackLevelLabel(track)}
                  class="w-full"
                  onScrubStart={() => editor.beginGesture()}
                  onInput={(value) => setTrackLevel(track.id, value)}
                  onCommit={(value) => {
                    setTrackLevel(track.id, value)
                    editor.finishGesture()
                  }}
                  onScrubEnd={() => editor.finishGesture()}
                />
              {/if}
            </div>
            {#each [{ key: 'locked', icon: CioLockOpen, activeIcon: CioLock, label: 'Lock', activeLabel: 'Unlock' }, { key: 'hidden', icon: CioEye, activeIcon: CioEyeOff, label: 'Hide', activeLabel: 'Show' }, { key: 'muted', icon: CioVolume, activeIcon: CioVolumeX, label: 'Mute', activeLabel: 'Unmute' }].filter((control) => control.key !== 'muted' || trackIsAudible(track)) as control (control.key)}
              {@const key = control.key as 'locked' | 'hidden' | 'muted'}
              <button
                type="button"
                class={[
                  'flex h-6 w-6 shrink-0 items-center justify-center hover:bg-elevated',
                  track[key] ? 'text-primary' : 'text-dimmed'
                ]}
                title={`${track[key] ? control.activeLabel : control.label} ${track.name}`}
                aria-label={`${track[key] ? control.activeLabel : control.label} ${track.name}`}
                data-track-control={key}
                aria-pressed={track[key]}
                onclick={() => toggleTrack(track.id, key)}
                >{#if track[key]}<control.activeIcon size={12} />{:else}<control.icon
                    size={10}
                  />{/if}</button
              >
            {/each}
            <StudioSidebarResizeHandle
              sidebarLabel={`${track.name} track height`}
              axis="y"
              value={trackHeight(track.id)}
              min={40}
              max={220}
              onResize={(value) => (rowHeights[track.id] = value)}
              onCommit={rememberRows}
              class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
            />
          </div>
        {/each}
        <div
          class="relative flex items-center gap-1 border-b border-border px-2"
          style:height={`${laneHeight(COMMENTS_ROW)}px`}
          role="group"
          aria-label="Comments lane"
        >
          <CioMessage size={11} class="shrink-0 text-dimmed" />
          <span class="truncate text-[0.625rem] text-muted">Comments</span>
          <span class="ml-auto shrink-0 text-[0.625rem] text-dimmed tabular-nums"
            >{comments.length}</span
          >
          <StudioSidebarResizeHandle
            sidebarLabel="comments lane height"
            axis="y"
            value={laneHeight(COMMENTS_ROW)}
            min={LANE_MIN_HEIGHT}
            max={LANE_MAX_HEIGHT}
            onResize={(value) => (rowHeights[COMMENTS_ROW] = value)}
            onCommit={rememberRows}
            class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
          />
        </div>
        <div
          class="relative flex items-center gap-1 border-b border-border px-2"
          style:height={`${laneHeight(AGENT_ROW)}px`}
          role="group"
          aria-label="Agent review lane"
        >
          <CioSparkles size={11} class="shrink-0 text-dimmed" />
          <span class="truncate text-[0.625rem] text-muted">Agent review</span>
          <span
            class={[
              'ml-auto shrink-0 text-[0.625rem] tabular-nums',
              agentPending ? 'text-primary' : 'text-dimmed'
            ]}
            >{agentEdits.length === 0
              ? 'None'
              : agentPending === 0
                ? 'Reviewed'
                : `${agentPending} new`}</span
          >
          <StudioSidebarResizeHandle
            sidebarLabel="agent review lane height"
            axis="y"
            value={laneHeight(AGENT_ROW)}
            min={LANE_MIN_HEIGHT}
            max={LANE_MAX_HEIGHT}
            onResize={(value) => (rowHeights[AGENT_ROW] = value)}
            onCommit={rememberRows}
            class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
          />
        </div>
      </div>
      <StudioSidebarResizeHandle
        sidebarLabel="track labels"
        value={labelWidth}
        min={112}
        max={320}
        onResize={(value) => {
          labelWidth = value
          if (viewport) width = Math.max(1, viewport.clientWidth - value - 6)
        }}
        onCommit={rememberRows}
        class="h-full w-1.5 shrink-0 cursor-col-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
      />
      <div class="shrink-0" style:width={`${contentWidth}px`}>
        <div class="relative min-h-full" style:width={`${contentWidth}px`}>
          <div
            class="sticky top-0 z-10 h-6 cursor-ew-resize touch-none border-b border-border bg-surface"
            role="slider"
            tabindex="0"
            aria-label="Timeline playhead"
            title="Drag to seek precisely"
            aria-valuemin="0"
            aria-valuemax={editor.duration}
            aria-valuenow={editor.time}
            onpointerdown={seekStart}
            onpointermove={(event) => {
              hoverTime = Math.max(0, Math.min(editor.duration, at(event)))
              if (scrubbing) editor.seek(at(event))
            }}
            onpointerleave={() => {
              if (!scrubbing) hoverTime = null
            }}
            onpointerup={() => (scrubbing = false)}
            onpointercancel={() => (scrubbing = false)}
            onkeydown={(event) => {
              if (keymapState.matches('video-edit-frame-back', event)) {
                event.preventDefault()
                editor.seek(editor.time - 1 / editor.fps)
              } else if (keymapState.matches('video-edit-frame-forward', event)) {
                event.preventDefault()
                editor.seek(editor.time + 1 / editor.fps)
              }
            }}
          >
            {#each ticks as tick (tick)}<span
                class="pointer-events-none absolute top-0 border-l border-border pl-1 font-mono text-[0.5625rem] leading-6 text-dimmed"
                style:left={`${tick * scale}px`}>{videoTimecode(tick)}</span
              >{/each}
            {#if hoverTime !== null}<span
                class="pointer-events-none absolute top-0 z-10 border-l border-primary bg-elevated px-1 font-mono text-[0.625rem] leading-6 text-foreground"
                style:left={`${hoverTime * scale}px`}
                >{videoTimecode(hoverTime)} · f{Math.round(hoverTime * editor.fps)}</span
              >{/if}
          </div>
          {#each editor.edit?.tracks ?? [] as track (track.id)}
            <div
              class="relative border-b border-border bg-app"
              style:height={`${trackHeight(track.id)}px`}
              data-video-track={track.id}
              role="group"
              aria-label={`${track.name} track`}
              ondragover={(event) => {
                event.preventDefault()
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
              }}
              ondrop={(event) => drop(event, track.id)}
            >
              {#if track.kind === 'caption'}{@render captionItems(track)}{/if}
              {#if track.kind === 'overlay'}{@render overlayItems(track)}{/if}
              {#each visibleClips.filter((clip) => clip.trackId === track.id) as clip (clip.id)}
                {@const asset = editor.edit?.assets.find((asset) => asset.id === clip.assetId)}
                <button
                  type="button"
                  class={[
                    'absolute top-1 flex min-w-1 touch-none items-center overflow-hidden border px-2 text-left text-[0.625rem]',
                    editor.selection?.kind === 'clip' && editor.selection.id === clip.id
                      ? 'border-primary bg-primary/25 text-foreground ring-2 ring-primary ring-inset'
                      : editor.isClipSelected(clip.id)
                        ? 'border-primary bg-primary/15 text-foreground'
                        : track.kind === 'audio'
                          ? 'border-success/35 bg-success/10 text-foreground'
                          : 'border-border bg-elevated text-foreground',
                    track.locked
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-grab active:cursor-grabbing'
                  ]}
                  style:left={`${clip.start * scale}px`}
                  style:width={`${Math.max(4, clip.duration * scale)}px`}
                  style:height={`${trackHeight(track.id) - 12}px`}
                  data-video-clip={clip.id}
                  aria-pressed={editor.isClipSelected(clip.id)}
                  title={`${asset?.name ?? 'Clip'} · ${videoTimecode(clip.start)} · drag to move; drag an edge to trim`}
                  aria-label={`${asset?.name ?? 'Clip'} at ${videoTimecode(clip.start)}`}
                  ondragstart={(event) => event.preventDefault()}
                  onpointerdown={(event) => startClip(event, clip.id)}
                  onclick={(event) => {
                    if (event.shiftKey || event.metaKey || event.ctrlKey) return
                    if (!editor.isClipSelected(clip.id)) editor.selectClip(clip.id)
                  }}
                  ondblclick={(event) => {
                    editor.seek(at(event))
                    editor.split()
                  }}
                >
                  <span
                    class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-border/50"
                    data-trim="start"
                  ></span>
                  {#each frameCells.filter((cell) => cell.clipId === clip.id) as cell (cell.key)}
                    {@const thumbnail = editor.frames.get(cell.key)}
                    {#if thumbnail}<img
                        draggable="false"
                        class="pointer-events-none absolute inset-y-0 h-full object-cover opacity-70"
                        src={thumbnail.image}
                        alt=""
                        style:left={`${(cell.time - clip.start) * scale}px`}
                        style:width={`${Math.max(1, (cell.end - cell.time) * scale)}px`}
                      />{/if}
                  {/each}
                  {#if editor.waveforms[editor.waveformKey(clip)]}
                    <img
                      class="pointer-events-none absolute inset-0 h-full w-full opacity-35"
                      src={editor.waveforms[editor.waveformKey(clip)] ?? undefined}
                      alt=""
                      draggable="false"
                    />
                  {/if}
                  <span class="pointer-events-none relative truncate bg-app/75 px-1"
                    >{asset?.name ?? 'Clip'}</span
                  >
                  <span
                    class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-border/50"
                    data-trim="end"
                  ></span>
                </button>
              {/each}
              <!--
                A comment that falls inside a clip is also marked on that clip's
                row: the lane below says a moment was commented on, and the row
                is what says on which moment of which track.
              -->

              <StudioSidebarResizeHandle
                sidebarLabel={`${track.name} track height`}
                axis="y"
                value={trackHeight(track.id)}
                min={40}
                max={220}
                onResize={(value) => (rowHeights[track.id] = value)}
                onCommit={rememberRows}
                class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
              />
            </div>
          {/each}
          <div
            class="relative border-b border-border bg-app"
            style:height={`${laneHeight(COMMENTS_ROW)}px`}
            role="group"
            aria-label="Comments on this composition"
          >
            {#if comments.length === 0}
              <span class="flex h-full items-center px-2 text-[0.625rem] text-dimmed"
                >No comments on this composition yet</span
              >
            {:else}
              {#each commentClusters as cluster (cluster.key)}
                {@const first = cluster.items[0]}
                <button
                  type="button"
                  class={[
                    'absolute top-1/2 flex h-4 -translate-y-1/2 items-center gap-0.5 border px-1 text-[0.5625rem] tabular-nums',
                    cluster.items.some((item) => item.reference.id === editingCommentId)
                      ? 'border-accent bg-accent/30 text-foreground'
                      : 'border-accent/45 bg-accent/10 text-foreground hover:border-accent hover:bg-accent/20'
                  ]}
                  style:left={`${cluster.x}px`}
                  data-video-comments={cluster.items.map((item) => item.reference.id).join(' ')}
                  title={commentClusterLabel(cluster)}
                  aria-label={commentClusterLabel(cluster)}
                  onclick={(event) => openComment(event, first)}
                >
                  {#if first.annotation}<CioPencil size={9} />{:else}<CioClapper size={9} />{/if}
                  <span>{cluster.items.length > 1 ? cluster.items.length : first.number}</span>
                </button>
              {/each}
            {/if}
          </div>
          <div
            class="relative border-b border-border bg-app"
            style:height={`${laneHeight(AGENT_ROW)}px`}
            role="group"
            aria-label="Agent edit review markers"
          >
            {#if agentEdits.length === 0}
              <span class="flex h-full items-center px-2 text-[0.625rem] text-dimmed"
                >No agent edits to review</span
              >
            {:else}
              {#each agentClusters as cluster (cluster.key)}
                {#if cluster.to > cluster.from}
                  <span
                    class="pointer-events-none absolute bottom-0.5 h-0.5 bg-primary/30"
                    style:left={`${cluster.from * scale}px`}
                    style:width={`${Math.max(1, (cluster.to - cluster.from) * scale)}px`}
                  ></span>
                {/if}
                <button
                  type="button"
                  class={[
                    'absolute top-1/2 flex h-4 -translate-y-1/2 items-center justify-center border text-[0.5625rem] tabular-nums',
                    cluster.items.length > 1 ? 'min-w-4 px-0.5' : 'w-4',
                    cluster.pending > 0
                      ? 'border-primary bg-primary/20 text-primary hover:bg-primary/30'
                      : 'border-border bg-elevated text-dimmed hover:text-foreground'
                  ]}
                  style:left={`${cluster.x}px`}
                  title={agentClusterLabel(cluster)}
                  aria-label={agentClusterLabel(cluster)}
                  onclick={() => editor.seek(cluster.from)}
                >
                  {#if cluster.items.length > 1}
                    <span>{cluster.items.length}</span>
                  {:else if cluster.pending > 0}
                    <CioSparkles size={10} />
                  {:else}
                    <CioCheck size={10} />
                  {/if}
                </button>
              {/each}
            {/if}
          </div>
          <div
            class="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
            style:left={`${editor.time * scale}px`}
          ></div>
        </div>
      </div>
    </div>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      data-layer-above-modal
      {...occlusion}
      class="z-80 flex max-h-[min(70vh,32rem)] min-w-64 flex-col overflow-y-auto overscroll-contain border border-border bg-surface py-1 shadow-lg"
    >
      {@render contextActions?.()}
      {#if editor.selectedClip}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item
          class="flex cursor-pointer items-center px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => void commentOnSelection()}
        >
          <span class="flex-1">Comment on the selected item</span>
        </ContextMenu.Item>
      {/if}
      {#if contextTrack}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item
          class="flex cursor-pointer items-center px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => editor.duplicateTrack(contextTrack)}
        >
          <span class="flex-1">Duplicate track</span>
        </ContextMenu.Item>
        <ContextMenu.Item
          class="flex cursor-pointer items-center px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => shiftTrack(-1)}
        >
          <span class="flex-1">Move track up</span>
        </ContextMenu.Item>
        <ContextMenu.Item
          class="flex cursor-pointer items-center px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => shiftTrack(1)}
        >
          <span class="flex-1">Move track down</span>
        </ContextMenu.Item>
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>

{#if commentEditor && editingComment}
  <!--
    The one comment bubble the app draws, anchored to the marker the reader
    clicked. A comment written on a moment, on a selected clip and drawn on a
    frame are all the same reference, so all three are read, edited and asked
    about here.

    The wrapper lifts the bubble over the surface the timeline is drawn on: the
    fullscreen editor is a modal, and a bubble painted under it would be a comment
    the user could see their marker for and never read.
  -->
  <div data-layer-above-modal class="relative z-80 pointer-events-auto">
    <ResponseAnnotationComment
      x={commentEditor.x}
      y={commentEditor.y}
      title={editingComment.annotation ? 'Comment on frame annotation' : 'Comment on moment'}
      dragHandleTitle={editingComment.annotation
        ? 'Move frame annotation comment'
        : 'Move moment comment'}
      closeLabel="Close comment"
      removeTitle={editingComment.annotation
        ? 'Remove this frame annotation and its comment'
        : 'Remove this note and its comment'}
      initialComment={editingComment.reference.comment ?? ''}
      targetId={`video-timeline-comment-${editor.threadId}-${editingComment.reference.id}`}
      scope={{ kind: 'project', projectId: editor.projectId }}
      chatSubject={editingComment.annotation ? 'frame annotation' : 'moment'}
      onDraftChange={draftComment}
      onDone={saveComment}
      onRemove={removeComment}
      onClose={closeComment}
      onExplain={() => chatAboutComment('elaborate')}
      onQuickChat={() => chatAboutComment('quick')}
    />
  </div>
{/if}
