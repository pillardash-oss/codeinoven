import { SvelteSet } from 'svelte/reactivity'

import { attachmentPreviewKind } from '$lib/mime'
import { invoke } from '$lib/ipc.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { parseComposerDraftEntry, type ComposerDraftEntry } from '$lib/stores/renderer-recovery'
import {
  mergeReferenceById,
  responseReferencesState,
  type ResponseReferenceAnchor
} from '$lib/stores/response-references.svelte'
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

/**
 * What a relocation carries: one composer attachment, one composer reference, or
 * the whole relocatable set a reference chip holds.
 *
 * The set is what the reference chip carries. The chip is its group's own handle
 * (hovering lists it, its close button clears it), so right-clicking the chip
 * carries everything inside it that belongs to the project.
 */
export type ComposerRelocationItem =
  | { kind: 'attachment'; attachment: PromptAttachment }
  | { kind: 'reference'; reference: PromptReference }
  | { kind: 'references'; references: readonly PromptReference[] }

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
  if (item.kind === 'attachment') {
    const kind = attachmentPreviewKind(item.attachment.mime, item.attachment.filename ?? '')
    const isMedia = kind === 'image' || kind === 'video' || kind === 'audio'
    return isMedia ? 'media attachment' : 'attachment'
  }
  if (item.kind === 'reference') return referenceNoun(item.reference)
  // One noun per kind: a lone reference is named, several of one kind are
  // counted, and a mixed set is named by the group, because neither noun would
  // describe all of it.
  const nouns = new SvelteSet(item.references.map(referenceNoun))
  const [only] = nouns
  if (item.references.length === 1) return only ?? 'comment'
  if (nouns.size === 1 && only === 'doc comment') return `${item.references.length} doc comments`
  if (nouns.size === 1) return `${item.references.length} inspector comments`
  return `${item.references.length} comments`
}

/** One reference's noun, which is what its kind means to the user. */
function referenceNoun(reference: PromptReference): string {
  return reference.kind === 'design' ? 'inspector comment' : 'doc comment'
}

/** The references an item carries, in their own order. */
export function itemReferences(item: ComposerRelocationItem): readonly PromptReference[] {
  if (item.kind === 'attachment') return []
  return item.kind === 'reference' ? [item.reference] : item.references
}

/** The item's own name: the file it carries, or the label the reference was made with. */
export function relocationItemName(item: ComposerRelocationItem): string {
  if (item.kind === 'attachment') {
    return item.attachment.filename ?? item.attachment.url.split('/').pop() ?? 'file'
  }
  if (item.kind === 'reference') return item.reference.label
  return `${item.references.length} attached references`
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

/**
 * Carry one composer item to another chat of the same project.
 *
 * The carry is a transaction, so a failure can never leave content in two places
 * or in none:
 *
 * 1. the destination is written and its draft is committed and awaited, so
 *    "carried" means persisted, not merely held in this window's memory;
 * 2. only then does the source give the item up, and its draft is committed and
 *    awaited too, so a restart cannot bring the item back to a chat it left;
 * 3. any failure restores every draft it touched, newest state last, and the
 *    caller reports it with nothing changed. A destination that cannot be read
 *    is refused before anything is written at all.
 */
export async function applyComposerRelocation(input: ComposerRelocationInput): Promise<void> {
  const { projectId, sourceThreadId, targetThreadId } = input
  // Read before writing: an unknown destination draft must never be overwritten.
  const targetBefore = await targetDraftEntry(projectId, targetThreadId)
  const carried = carryInto(targetBefore, input)
  const targetAfter = carried.entry

  try {
    writeDraft(projectId, targetThreadId, targetAfter)
    syncReferences(projectId, targetThreadId, targetAfter)
    await commitDraft(projectId, targetThreadId)
  } catch (error) {
    restoreDraft(projectId, targetThreadId, targetBefore)
    throw error
  }

  if (input.mode !== 'relocate') return

  // The item is in the destination for good, so the source may give it up.
  const sourceBefore = sourceDraft(input)
  const sourceAfter = dropFromSource(sourceBefore, input)
  try {
    writeDraft(projectId, sourceThreadId, sourceAfter)
    syncReferences(projectId, sourceThreadId, sourceAfter)
    await commitDraft(projectId, sourceThreadId)
  } catch (error) {
    // The move failed as a whole: the source keeps its item and the destination
    // is put back exactly as it was.
    restoreDraft(projectId, sourceThreadId, sourceBefore)
    restoreDraft(projectId, targetThreadId, targetBefore)
    await commitDraft(projectId, targetThreadId).catch(() => undefined)
    throw error
  }
}

/**
 * The destination's draft with the carried item added to it.
 *
 * Nothing the destination holds is replaced: a file it already attached keeps
 * its one chip for its `file://` key, and a reference id it already holds is the
 * same reference, so the carried content updates that entry where it sits rather
 * than arriving under a repeated key.
 */
function carryInto(
  entry: ComposerDraftEntry | null,
  input: ComposerRelocationInput
): { entry: ComposerDraftEntry } {
  const carried: ComposerDraftEntry = {
    text: entry?.text ?? '',
    attachments: entry?.attachments ?? [],
    projectReferences: entry?.projectReferences ?? [],
    taskReferences: entry?.taskReferences ?? [],
    promptReferences: entry?.promptReferences ?? [],
    startAfterThreads: entry?.startAfterThreads ?? []
  }

  if (input.item.kind === 'attachment') {
    carried.attachments = uniqueAttachments([...carried.attachments, input.item.attachment])
    return { entry: carried }
  }

  const references = itemReferences(input.item).map((reference) =>
    // A copy is a new reference, never the same one twice: a reference is
    // identified by its id, and both chats must be able to edit their own.
    input.mode === 'copy' ? { ...reference, id: copiedReferenceId() } : reference
  )
  carried.promptReferences = references.reduce<ResponseReferenceAnchor[]>(
    (known, reference) => mergeReferenceById(known, reference),
    carried.promptReferences
  )
  return { entry: carried }
}

/** The source's draft with the carried item taken out of it. */
function dropFromSource(
  entry: ComposerDraftEntry,
  input: ComposerRelocationInput
): ComposerDraftEntry {
  if (input.item.kind === 'attachment') {
    const identity = attachmentFileIdentity(input.item.attachment)
    return {
      ...entry,
      attachments: entry.attachments.filter(
        (candidate) => attachmentFileIdentity(candidate) !== identity
      )
    }
  }
  const moved = new SvelteSet(itemReferences(input.item).map((reference) => reference.id))
  return {
    ...entry,
    promptReferences: entry.promptReferences.filter((candidate) => !moved.has(candidate.id))
  }
}

/** Every part of a thread's composer draft, so a rollback is exact. */
function sourceDraft(input: ComposerRelocationInput): ComposerDraftEntry {
  const { projectId, sourceThreadId } = input
  return {
    text: rendererRecovery.draftFor(projectId, sourceThreadId),
    attachments: rendererRecovery.attachmentsFor(projectId, sourceThreadId),
    projectReferences: rendererRecovery.projectReferencesFor(projectId, sourceThreadId),
    taskReferences: rendererRecovery.taskReferencesFor(projectId, sourceThreadId),
    promptReferences: rendererRecovery.draftPromptReferences(projectId, sourceThreadId),
    startAfterThreads: rendererRecovery.startAfterThreadsFor(projectId, sourceThreadId)
  }
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
 * existing ones over, and the commit reads the entry the last write left behind.
 */
function writeDraft(projectId: string, threadId: string, entry: ComposerDraftEntry): void {
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

/**
 * Keep the in-memory reference store in step with a draft this carry wrote.
 *
 * The store is what draws the pins, the chips and the popover rows, so a draft
 * written for a thread the user is looking at is only half-written until the
 * store agrees with it.
 */
function syncReferences(projectId: string, threadId: string, entry: ComposerDraftEntry): void {
  responseReferencesState.setForThread(projectId, threadId, entry.promptReferences)
}

/**
 * Commit a thread's composer draft now and wait for main to have it.
 *
 * The composer's own commits are debounced by ten seconds of inactivity, which
 * is right for typing and wrong for a carry: "carried" has to mean persisted
 * before the source gives anything up, or a window that dies in between loses the
 * item from both chats.
 */
async function commitDraft(projectId: string, threadId: string): Promise<void> {
  const draftJson = rendererRecovery.composerDraftJson(projectId, threadId)
  await invoke('thread:setDraftState', projectId, threadId, draftJson !== null, draftJson)
}

/** Put a thread's draft back exactly as it was before a carry touched it. */
function restoreDraft(projectId: string, threadId: string, entry: ComposerDraftEntry | null): void {
  if (entry === null) {
    // Nothing was there before, so nothing may be left behind.
    rendererRecovery.clearDraft(projectId, threadId)
    responseReferencesState.setForThread(projectId, threadId, [])
    return
  }
  writeDraft(projectId, threadId, entry)
  syncReferences(projectId, threadId, entry)
}
