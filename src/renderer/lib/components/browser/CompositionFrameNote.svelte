<script lang="ts">
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import { onMount } from 'svelte'
  import type { CompositionFrameSnapshot } from '$shared/ipc-contract'
  import Modal from '../ui/Modal.svelte'
  import AnnotationCommentForm from '../chats/AnnotationCommentForm.svelte'
  import ArtifactImageAnnotator from '../threads/ArtifactImageAnnotator.svelte'
  import { responseReferencesState } from '$lib/stores/response-references.svelte'

  /**
   * A note on one frame of a composition.
   *
   * A composition is a page, not a file, so "that moment there" has nowhere to
   * live on disk until someone captures it. The transport pauses the playhead,
   * main draws and keeps the frame, and this surface is where the user says what
   * is wrong with it: circle the area, and/or write the comment.
   *
   * Both halves reach the agent as one reference. The picture is what it looks at
   * (the send composes the marks onto it), and the descriptor names the moment to
   * the millisecond, so the frame it sees and the frame it must fix are the same
   * one even after the edit moves the timeline.
   *
   * The comment is written here rather than only in a mark's bubble, because not
   * every comment about a frame is about a place on it: "the caption is still the
   * old one" is about the whole frame, and dragging a circle around the entire
   * picture to say so would be noise on the screenshot.
   */
  interface Props {
    projectId: string
    threadId: string
    snapshot: CompositionFrameSnapshot
    /** Whether the pen starts armed: the pen button opens this surface to draw. */
    armed: boolean
    onClose: () => void
  }

  let { projectId, threadId, snapshot, armed, onClose }: Props = $props()

  /**
   * The reference that names the frame itself.
   *
   * Minted once per open surface, because the frame is one reference however many
   * marks are drawn on it: the marks are their own references, and this one is
   * the picture plus the moment plus the comment.
   */
  const frameId = crypto.randomUUID()

  /**
   * The capture this surface was opened for.
   *
   * A note is about one frame, and a surface opened on it is opened once: the
   * descriptor below names that frame, so it is built from this value rather
   * than from a prop that a later capture could replace mid-edit.
   */
  // svelte-ignore state_referenced_locally
  const frame = snapshot

  /** What the agent reads about the moment, in the same shape a video note uses. */
  const detail = [
    `Composition: ${frame.directory}`,
    `timecode: ${frame.timecode}`,
    `seconds: ${frame.seconds.toFixed(3)}`,
    `frame: ${frame.frame} (at ${frame.fps} fps)`,
    `duration: ${frame.duration}`,
    `frame picture: ${frame.path}`
  ].join('\n')

  const references = $derived(responseReferencesState.forThread(projectId, threadId))
  const frameNote = $derived(references.find((entry) => entry.id === frameId) ?? null)
  /**
   * The strokes drawn on this frame.
   *
   * The frame's own reference is excluded: it names a picture, not a place on it,
   * so it has no badge and nothing to edit from the pen surface.
   */
  const marks = $derived(
    references.filter(
      (entry) => entry.kind === 'image' && entry.mediaUrl === snapshot.url && entry.id !== frameId
    )
  )

  // The reference exists from the moment the surface opens, so the composer lists
  // the frame while the user is writing about it rather than only on Done. It is
  // written once, after mount, because the composer is another component's render
  // and a mount is where a new surface announces what it brought.
  onMount(() => {
    responseReferencesState.setForThread(projectId, threadId, [
      ...responseReferencesState.forThread(projectId, threadId),
      {
        id: frameId,
        label: '',
        text: `Frame of "${snapshot.directory}" at ${snapshot.timecode}\n${detail}`,
        kind: 'image',
        mediaUrl: snapshot.url
      }
    ])
  })

  function saveComment(comment: string): void {
    responseReferencesState.updateComment(projectId, threadId, frameId, comment)
    close()
  }

  function draftComment(comment: string): void {
    responseReferencesState.updateCommentDraft(projectId, threadId, frameId, comment)
  }

  function removeFrame(): void {
    drop()
    onClose()
  }

  /** Remove this frame's own reference, leaving the marks drawn on it alone. */
  function drop(): void {
    responseReferencesState.setForThread(
      projectId,
      threadId,
      responseReferencesState.forThread(projectId, threadId).filter((entry) => entry.id !== frameId)
    )
  }

  /**
   * Close the surface, dropping a note the user left without a comment.
   *
   * A frame reference with neither a comment nor a stroke in it is a capture
   * nobody asked to keep, and leaving it would put an empty `Mark N` in the
   * composer every time someone looked at a frame and changed their mind.
   */
  function close(): void {
    const current = responseReferencesState
      .forThread(projectId, threadId)
      .find((entry) => entry.id === frameId)
    const hasComment = (current?.comment ?? '').trim() !== ''
    if (!hasComment && marks.length === 0) drop()
    onClose()
  }
</script>

<Modal
  open
  title={`Frame ${snapshot.timecode}`}
  onClose={close}
  placement="fullscreen"
  panelClass="bg-app"
  contentClass="flex flex-col overflow-hidden p-0"
>
  <div
    class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-3 py-1.5 text-[0.6875rem] text-muted"
  >
    <span class="flex items-center gap-1.5 font-mono text-foreground">
      <CioClapper size={12} class="text-accent" />
      {snapshot.timecode}
    </span>
    <span class="tabular-nums">frame {snapshot.frame}</span>
    <span class="tabular-nums">{snapshot.fps} fps</span>
    <span class="min-w-0 truncate" title={snapshot.directory}>{snapshot.directory}</span>
    <span class="tabular-nums text-dimmed">{snapshot.width}×{snapshot.height}</span>
  </div>
  <div class="min-h-0 flex-1">
    <ArtifactImageAnnotator
      {projectId}
      {threadId}
      url={snapshot.url}
      filename={snapshot.path}
      {marks}
      editingId={null}
      onEditClosed={() => {}}
      moment={{
        seconds: snapshot.seconds,
        timecode: snapshot.timecode,
        detail
      }}
      startArmed={armed}
    />
  </div>
  <div class="shrink-0 border-t border-border bg-surface p-2">
    <AnnotationCommentForm
      initialComment={frameNote?.comment ?? ''}
      targetId={`frame-note-${threadId}-${frameId}`}
      scope={{ kind: 'project', projectId }}
      placeholder="What should change at this frame?"
      fieldClass="h-16 min-h-16"
      doneTitle="Attach this frame note"
      removeTitle="Remove this frame note and its picture"
      onDraftChange={draftComment}
      onDone={saveComment}
      onRemove={removeFrame}
      onClose={close}
    />
  </div>
</Modal>
