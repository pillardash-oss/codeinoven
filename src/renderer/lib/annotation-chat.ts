import { contextSidebarState, EXPLAIN_SELECTION_PROMPT } from '$lib/stores/context-sidebar.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'

/**
 * Asking a question about an annotation, from the annotation itself.
 *
 * Every annotation in the app (a studio passage, an element picked in an online
 * artifact, a mark drawn on a published picture, a moment in the video editor, an
 * element picked in the design inspector, a passage of a document) is already a
 * composer reference carrying a descriptor the agent reads. Explain and Quick
 * Chat ask about that same descriptor, so the side chat is opened here once
 * rather than by each surface, and each surface supplies only the framing its
 * descriptor cannot carry on its own.
 */

/** The two read-only side chats every annotation offers. */
export type AnnotationChatMode = 'elaborate' | 'quick'

/** Ceiling on an artifact's source when it rides along as context, matching the
 *  caps the document and studio contexts already use. */
const ARTIFACT_CONTEXT_LIMIT = 24_000

/**
 * Open the read-only side chat for one annotation.
 *
 * The settings are the app's last-used thread settings, not the conversation's
 * live ones: an annotation can be written from a panel (a browser tab, a file
 * panel, the board), which owns no settings of its own, and that is how every
 * other out-of-conversation surface opens a side chat.
 */
export function openAnnotationChat(request: {
  projectId: string
  threadId: string
  mode: AnnotationChatMode
  /** The annotation's own descriptor: what the user is asking about. */
  selection: string
  /** The bounded surroundings that make the descriptor readable. */
  context: string
}): void {
  contextSidebarState.openTemporaryChat(
    request.projectId,
    request.threadId,
    request.mode,
    request.selection,
    request.context,
    threadSettings.lastUsed,
    true,
    request.mode === 'elaborate' ? EXPLAIN_SELECTION_PROMPT : undefined
  )
}

/** The element inspector of an inline artifact, as context for its picks. */
export function artifactInspectorChatContext(
  kind: string,
  source: string,
  surface: string
): string {
  const bounded =
    source.length <= ARTIFACT_CONTEXT_LIMIT
      ? source
      : `${source.slice(0, ARTIFACT_CONTEXT_LIMIT)}\n\n[Artifact source truncated for context limit]`
  return [
    `The user is inspecting a ${surface} artifact the agent published in this conversation, and selected an element of it. The attached selection is that element's descriptor (its path, tag, classes and text). Treat the artifact below as read-only context, and read the project file that authored it when the element refers to anything outside this document.`,
    `<inline-artifact kind="${kind}">`,
    bounded,
    '</inline-artifact>'
  ].join('\n\n')
}

/** A mark drawn on a picture the agent published in the conversation. */
export function mediaMarkChatContext(marked: 'still picture' | 'video frame'): string {
  return [
    `The user drew a mark on a ${marked} the agent published in this conversation. The attached selection is the mark's descriptor: which part of the response it was drawn on, and for a frame the second it belongs to. The picture itself is already in this conversation above, so read it there rather than expecting a second copy here.`
  ].join('\n\n')
}

/** A moment noted on a composition in the video editor. */
export function videoMomentChatContext(directory: string): string {
  return [
    `The user noted a moment on a video composition in the video editor. The attached selection is that moment's descriptor: the composition, its timecode and frame, the caption it falls inside, and the controls the document addresses. The editable composition is the folder below; read it there rather than guessing at the file.`,
    `<video-composition directory="${directory}">`,
    '</video-composition>'
  ].join('\n\n')
}

/** An element picked on a design served in the app's browser. */
export function designElementChatContext(
  directory: string | undefined,
  entry: string | undefined
): string {
  const attributes = [
    directory ? ` directory="${directory}"` : '',
    entry ? ` entry="${entry}"` : ''
  ].join('')
  return [
    `The user inspected a design the app's browser is serving and selected an element of it. The attached selection is that element's descriptor (its path, tag, classes and text). The page is a live render, so read the design folder below to change what the element actually is.`,
    `<design-element${attributes}>`,
    '</design-element>'
  ].join('\n\n')
}
