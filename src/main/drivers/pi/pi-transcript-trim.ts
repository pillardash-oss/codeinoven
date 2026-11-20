/**
 * Trim a Pi session transcript in place, without starting Pi.
 *
 * Pi's session file is a JSONL tree of entries. Its own history editing works
 * the same way a running agent's edit does: a `context_edit` entry is appended
 * that targets an earlier model-visible entry, and the context builder applies
 * it when projecting the branch. A rule of `null` removes the target from the
 * model context; the original entry stays on disk, so the edit is reversible and
 * the transcript keeps its full audit trail.
 *
 * This module appends those records directly. It deliberately does not import
 * the Pi SDK: the main bundle must not carry the harness runtime just to write
 * six fields onto a line, and the format is the same one `pi-native-session.ts`
 * already reads. The live session (if any) reloads the file afterwards, which is
 * what makes the trim visible to the running agent without a new process.
 */
import { readFile, appendFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { AgentMessage } from '../../../lib/types'

/** Roles Pi treats as editable model content. */
const EDITABLE_ROLES = new Set(['user', 'assistant', 'toolResult'])
/** Characters of a message kept for matching; the tail is not needed to be sure. */
const MATCH_PREFIX_CHARS = 300

/** One parsed transcript entry, as far as trimming needs to understand it. */
interface TranscriptEntry {
  id: string
  parentId: string | null
  type: string
  role: string | null
  text: string
}

export interface PiTranscriptTrimResult {
  /** `context_edit` records appended to the transcript. */
  edited: number
  /**
   * Removed user turns with no matching transcript entry. A user message that
   * cannot be found means the two histories disagree, so the caller must not
   * treat the trim as applied.
   */
  missing: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: Record<string, unknown>, key: string): string | null {
  const field = value[key]
  return typeof field === 'string' && field.length > 0 ? field : null
}

/** Flatten one transcript message's content into the text a reader compares. */
function entryText(message: Record<string, unknown>): string {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const part of content) {
    if (!isRecord(part) || part['type'] !== 'text') continue
    const text = part['text']
    if (typeof text === 'string') chunks.push(text)
  }
  return chunks.join('\n')
}

/** The same flattening for the app's mirrored message. */
function messageText(message: AgentMessage): string {
  const chunks: string[] = []
  for (const part of message.parts) {
    if (part.type !== 'text') continue
    const text = part.text
    if (typeof text === 'string' && text.length > 0) chunks.push(text)
  }
  return chunks.join('\n')
}

/** Whitespace-insensitive head of a text, so formatting alone never unfinds it. */
function matchKey(text: string, chars = MATCH_PREFIX_CHARS): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, chars)
}

function parseEntry(line: string): TranscriptEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const id = stringOf(parsed, 'id')
  if (id === null) return null
  const type = stringOf(parsed, 'type') ?? 'unknown'
  const parent = stringOf(parsed, 'parentId')
  const message = isRecord(parsed['message']) ? parsed['message'] : null
  const role = message === null ? null : stringOf(message, 'role')
  return {
    id,
    parentId: parent,
    type,
    role,
    text: message === null ? '' : entryText(message)
  }
}

/** The active branch, oldest first: the leaf and its ancestors, reversed. */
function activeBranch(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: TranscriptEntry[] = []
  let cursor = entries.at(-1) ?? null
  const seen = new Set<string>()
  while (cursor !== null && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    branch.push(cursor)
    cursor = cursor.parentId === null ? null : (byId.get(cursor.parentId) ?? null)
  }
  return branch.reverse()
}

function freshId(taken: ReadonlySet<string>): string {
  for (;;) {
    const id = randomBytes(4).toString('hex')
    if (!taken.has(id)) return id
  }
}

/**
 * Remove the given messages from a transcript's model context.
 *
 * Matches are positional on the active branch: each removed message is looked up
 * among the not-yet-removed entries of the same role by the head of its text, so
 * a duplicated message can never remove the wrong occurrence and no lookup
 * depends on ids the app does not keep. Entries the app mirrors without a
 * transcript counterpart (a compaction marker, an empty placeholder) are
 * skipped, exactly like a message the transcript already dropped.
 */
export async function trimPiTranscript(
  sessionFile: string,
  removed: readonly AgentMessage[]
): Promise<PiTranscriptTrimResult> {
  const raw = await readFile(sessionFile, 'utf8')
  const entries = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseEntry)
    .filter((entry): entry is TranscriptEntry => entry !== null)
  if (entries.length === 0) return { edited: 0, missing: 0 }

  const branch = activeBranch(entries)
  const editable = branch.filter(
    (entry) => entry.type === 'message' && entry.role !== null && EDITABLE_ROLES.has(entry.role)
  )
  const removedIds = new Set<string>()
  let missing = 0

  const takeMatch = (role: string, text: string): TranscriptEntry | null => {
    const key = matchKey(text)
    const found = editable.find(
      (entry) =>
        !removedIds.has(entry.id) &&
        entry.role === role &&
        (key.length === 0 ? matchKey(entry.text).length === 0 : matchKey(entry.text) === key)
    )
    if (found) removedIds.add(found.id)
    return found ?? null
  }

  for (const message of removed) {
    const role = message.role
    if (!EDITABLE_ROLES.has(role)) continue
    const text = messageText(message)
    // An assistant mirror row with no text is a placeholder the transcript may
    // never have carried (a compaction marker). Only a user turn is required to
    // exist, because losing one would silently keep old prompt text in context.
    if (text.trim().length === 0) {
      if (role === 'user') missing += 1
      continue
    }
    const match = takeMatch(role, text)
    if (match === null && role === 'user') missing += 1
    if (match === null || role !== 'assistant') continue
    // A removed assistant message takes its tool results with it: a result with
    // no call is a request the provider rejects, and Pi's context builder keeps
    // them adjacent only while both sides are present. Results are the
    // assistant entry's descendants, so the walk follows parent links instead of
    // assuming the next line is one.
    const pending = [match.id]
    while (pending.length > 0) {
      const parentId = pending.pop()
      for (const entry of editable) {
        if (removedIds.has(entry.id) || entry.parentId !== parentId) continue
        if (entry.role !== 'toolResult') continue
        removedIds.add(entry.id)
        pending.push(entry.id)
      }
    }
  }

  if (removedIds.size === 0) return { edited: 0, missing }
  // A removed user turn that the transcript does not carry means the two
  // histories disagree. Refusing here keeps the caller's destructive fallback
  // from running against a transcript this function already edited.
  if (missing > 0) return { edited: 0, missing }

  const taken = new Set(entries.map((entry) => entry.id))
  let leaf = entries.at(-1)?.id ?? null
  const lines: string[] = []
  // Oldest first, so each edit's parent is the record before it and the branch
  // stays a chain Pi can walk from its leaf.
  for (const entry of editable) {
    if (!removedIds.has(entry.id)) continue
    const id = freshId(taken)
    taken.add(id)
    lines.push(
      JSON.stringify({
        type: 'context_edit',
        id,
        parentId: leaf,
        timestamp: new Date().toISOString(),
        targetId: entry.id,
        replacement: null
      })
    )
    leaf = id
  }
  if (lines.length === 0) return { edited: 0, missing }
  await appendFile(sessionFile, `${lines.join('\n')}\n`, { encoding: 'utf8' })
  return { edited: lines.length, missing }
}
