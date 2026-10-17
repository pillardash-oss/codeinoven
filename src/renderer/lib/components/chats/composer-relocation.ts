import { attachmentPreviewKind } from '$lib/mime'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { parseComposerDraftEntry, type ComposerDraftEntry } from '$lib/stores/renderer-recovery'
import { mergeReferenceById, responseReferencesState } from '$lib/stores/response-references.svelte'
import type { PromptAttachment, PromptReference } from '$shared/types'
import { attachmentFileIdentity, uniqueAttachments } from './chat-composer-attachments'

/**
 * Carrying composer content from one chat to another in the same project.
 *
 * Three kinds of composer chip hold content that belongs to the project rather
 * than to the conversation: an attached file, a doc comment (a passage
 * annotated in the file panel), and an inspector comment (an element picked in
 * the in-app browser). All three can be handed to a different chat of the same
 * project, because the file, the document and the design exist for every thread
 * of that project.
 *
 * Two chips hold thread-scoped content and are deliberately not offered:
 * a conversation comment (an excerpt of a message, which no other conversation
 * contains) and a mark drawn on an inline artifact (which belongs to the
 * message that published the picture). Neither can mean anything elsewhere.
 *
 * Moving writes the destination's own composer draft, read the way its composer
 * will read it: this window's entry when it has a newer one, otherwise the
 * thread's committed draft, so a chat nobody opened keeps its text, its files
 * and its start-after threads.
 *
 * A carried attachment keeps pointing at the same file. An attachment file is
 * either a project file every thread of the project can reach, or a copy the app
 * retained in its own scratch, and neither becomes a different file because
 * another chat references it   duplicating it would leave two files where the
 * user attached one.
 *
 * Nothing the destination already holds is replaced by arriving content: its own
 * references and attachments are kept and the carried item joins them. A file it
 * already attached keeps its one chip, and a reference id that is somehow
 * already there is the same reference, so the carried content updates that entry
 * where it sits instead of adding a second chip under a repeated key.
 */

/** What a relocation carries: one composer attachment or one composer reference. */
export type ComposerRelocationItem =
  | { kind: 'attachment'; attachment: PromptAttachment }
  | { kind: 'reference'; reference: PromptReference }

/** `relocate` takes the item out of the source chat; `copy` leaves it there. */
export type ComposerRelocationMode = 'relocate' | 'copy'

/**
 * What a composer chip calls when the user picks Relocate or Copy.
 *
 * The chip names the item; the surface that hosts the composer owns the target
 * chat picker and the move itself.
 */
export type ComposerRelocationRequest = (
  item: ComposerRelocationItem,
  mode: ComposerRelocationMode
) => void

/** The reference kinds whose content belongs to the project, not the thread. */
const RELOCATABLE_REFERENCE_KINDS: readonly NonNullable<PromptReference['kind']>[] = [
  'file',
  'design'
]

/**
 * Whether a reference can be carried to another chat.
 *
 * A doc comment and an inspector comment name a document and an element that
 * every thread of the project can reach; a conversation comment names a message
 * range, and an inline-artifact annotation names a picture a single message
 * published, so both are left where they were written.
 */
export function isRelocatableReference(reference: Pick<PromptReference, 'kind'>): boolean {
  return RELOCATABLE_REFERENCE_KINDS.includes(reference.kind ?? 'selection')
}

/** What the menu and the confirmation call the item, e.g. `media attachment`. */
export function relocationNoun(item: ComposerRelocationItem): string {
  if (item.kind === 'reference') {
    return item.reference.kind === 'design' ? 'inspector comment' : 'doc comment'
  }
  const kind = attachmentPreviewKind(item.attachment.mime, item.attachment.filename ?? '')
  const isMedia = kind === 'image' || kind === 'video' || kind === 'audio'
  return isMedia ? 'media attachment' : 'attachment'
}

/** The item's own name: the file it carries, or the label the reference was made with. */
export function relocationItemName(item: ComposerRelocationItem): string {
  if (item.kind === 'reference') return item.reference.label
  return item.attachment.filename ?? item.attachment.url.split('/').pop() ?? 'file'
}

/** The menu entry that starts a relocation, e.g. `Relocate doc comment`. */
export function relocationActionLabel(
  mode: ComposerRelocationMode,
  item: ComposerRelocationItem
): string {
  return `${mode === 'copy' ? 'Copy' : 'Relocate'} ${relocationNoun(item)}`
}

export interface ComposerRelocationInput {
  projectId: string
  /** The chat the item is written in. */
  sourceThreadId: string
  /** The chat the item is carried to. */
  targetThreadId: string
  item: ComposerRelocationItem
  mode: ComposerRelocationMode
}

/** Carry one composer item to another chat of the same project. */
export async function applyComposerRelocation(input: ComposerRelocationInput): Promise<void> {
  const entry = await targetDraftEntry(input.projectId, input.targetThreadId)
  const carried: ComposerDraftEntry = {
    text: entry?.text ?? '',
    attachments: entry?.attachments ?? [],
    projectReferences: entry?.projectReferences ?? [],
    taskReferences: entry?.taskReferences ?? [],
    promptReferences: entry?.promptReferences ?? [],
    startAfterThreads: entry?.startAfterThreads ?? []
  }

  if (input.item.kind === 'attachment') {
    // Appending to a file the destination already attached would leave two chips
    // with one `file://` key, so the duplicate guard drops the repeat: the file
    // is already there and the destination keeps its single chip for it.
    carried.attachments = uniqueAttachments([...carried.attachments, input.item.attachment])
    writeTargetDraft(input.projectId, input.targetThreadId, carried)
    if (input.mode === 'relocate') dropSourceAttachment(input, input.item.attachment)
    return
  }

  // A copy is a new reference, never the same one twice: a reference is
  // identified by its id, and both chats must be able to edit their own.
  const reference =
    input.mode === 'copy'
      ? { ...input.item.reference, id: copiedReferenceId() }
      : input.item.reference
  // The destination's own annotations are kept and the carried one is added to
  // them, never in place of them. A reference id that is somehow already there
  // is the same reference, so the carried content updates that entry where it
  // sits rather than arriving as a second chip the composer would reject as a
  // repeated key. The composer's own ceiling of twenty references per thread
  // still applies to the result, exactly as it does to any other composer write.
  carried.promptReferences = mergeReferenceById(carried.promptReferences, reference)
  writeTargetDraft(input.projectId, input.targetThreadId, carried)
  responseReferencesState.setForThread(
    input.projectId,
    input.targetThreadId,
    carried.promptReferences
  )
  if (input.mode === 'relocate') dropSourceReference(input, input.item.reference.id)
}

/**
 * The destination's composer draft, as its own composer would find it.
 *
 * A draft this window holds is newer than the database's delayed snapshot, so
 * it wins. A destination nobody opened here is read from the thread's committed
 * draft instead, which is what keeps its existing text, files and references.
 *
 * Throws when the destination cannot be read: an unknown draft must never be
 * overwritten with an empty one, and the caller reports the refusal.
 */
async function targetDraftEntry(
  projectId: string,
  threadId: string
): Promise<ComposerDraftEntry | null> {
  const local = rendererRecovery.composerDraftJson(projectId, threadId)
  if (local) return parseDraft(local)
  const thread = await invoke('thread:get', projectId, threadId)
  if (!thread) throw new Error('That chat is no longer in this project.')
  return thread.draftJson ? parseDraft(thread.draftJson) : null
}

function parseDraft(raw: string): ComposerDraftEntry | null {
  try {
    return parseComposerDraftEntry(JSON.parse(raw))
  } catch {
    return null
  }
}

/** One id for one picked element, matching how a doc annotation mints its own. */
function copiedReferenceId(): string {
  return crypto.randomUUID()
}

/**
 * Write a thread's composer draft the way its own composer writes it.
 *
 * The start-after threads go first because `setDraft` carries the entry's
 * existing ones over, and the debounced database commit reads the entry the
 * last write left behind.
 */
function writeTargetDraft(projectId: string, threadId: string, entry: ComposerDraftEntry): void {
  if (entry.startAfterThreads.length > 0) {
    rendererRecovery.setStartAfterThreads(projectId, threadId, entry.startAfterThreads)
  }
  rendererRecovery.setDraft(
    projectId,
    threadId,
    entry.text,
    entry.attachments,
    entry.projectReferences,
    entry.taskReferences,
    entry.promptReferences
  )
}

/** Take a moved attachment out of the source composer, keeping everything else. */
function dropSourceAttachment(
  input: Pick<ComposerRelocationInput, 'projectId' | 'sourceThreadId'>,
  attachment: PromptAttachment
): void {
  const { projectId, sourceThreadId } = input
  const identity = attachmentFileIdentity(attachment)
  rendererRecovery.setDraft(
    projectId,
    sourceThreadId,
    rendererRecovery.draftFor(projectId, sourceThreadId),
    rendererRecovery
      .attachmentsFor(projectId, sourceThreadId)
      .filter((candidate) => attachmentFileIdentity(candidate) !== identity),
    rendererRecovery.projectReferencesFor(projectId, sourceThreadId),
    rendererRecovery.taskReferencesFor(projectId, sourceThreadId),
    rendererRecovery.draftPromptReferences(projectId, sourceThreadId)
  )
}

/** Take a moved reference out of the source composer, keeping everything else. */
function dropSourceReference(
  input: Pick<ComposerRelocationInput, 'projectId' | 'sourceThreadId'>,
  referenceId: string
): void {
  const { projectId, sourceThreadId } = input
  responseReferencesState.setForThread(
    projectId,
    sourceThreadId,
    responseReferencesState
      .forThread(projectId, sourceThreadId)
      .filter((candidate) => candidate.id !== referenceId)
  )
}
