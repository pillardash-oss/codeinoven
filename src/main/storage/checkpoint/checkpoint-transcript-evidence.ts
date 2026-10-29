import type { AgentPart, FileChangeSource } from '../../../lib/types'
import { changedPathsFromTool, fileChangeSource } from '../../chat/chat-engine/chat-engine-changes'

/**
 * Bounded read of one turn's own mirrored transcript. A turn is a few hundred
 * messages at most, and completion must never wait on an unbounded scan.
 */
export const TRANSCRIPT_EVIDENCE_MESSAGE_LIMIT = 240

/** Kept identical to the live recorder so a card never shows more provenance. */
const MAX_SOURCES_PER_PATH = 4

/** One mirrored message row, reduced to the only column evidence comes from. */
export interface TranscriptEvidenceRow {
  parts: unknown
}

/**
 * Write evidence the durable transcript proves for one turn.
 *
 * Live part events are the normal source of tool provenance, but a driver is
 * free to publish only settled messages, and a resumed or re-registered
 * session can lose the in-memory transcript entirely. The mirror the app
 * writes is the one transcript every driver shares, so completion re-derives
 * the turn's write targets from it. Paths are only evidence, never a change:
 * completion still intersects them with the real snapshot diff.
 */
export function transcriptWriteEvidence(
  projectPath: string,
  rows: readonly TranscriptEvidenceRow[]
): Map<string, FileChangeSource[]> {
  const evidence = new Map<string, FileChangeSource[]>()
  for (const row of rows) {
    const parts = parseParts(row.parts)
    for (const value of parts) {
      const part = toolPart(value)
      if (!part) continue
      const source = fileChangeSource(part)
      if (!source) continue
      for (const path of changedPathsFromTool(projectPath, part)) {
        const sources = evidence.get(path) ?? []
        if (sources.some((entry) => entry.toolPartId === source.toolPartId)) continue
        evidence.set(path, [...sources.slice(-(MAX_SOURCES_PER_PATH - 1)), source])
      }
    }
  }
  return evidence
}

function parseParts(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Validate a mirrored tool part into the shape the attribution rules read.
 *
 * The row is JSON that outlived the process that wrote it, so every field is
 * checked instead of asserted: an unknown or half-written part is skipped
 * rather than credited to the turn.
 */
function toolPart(value: unknown): Extract<AgentPart, { type: 'tool' }> | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (record['type'] !== 'tool') return null
  const id = record['id']
  const messageID = record['messageID']
  const tool = record['tool']
  const state = record['state']
  if (typeof id !== 'string' || typeof messageID !== 'string' || typeof tool !== 'string') {
    return null
  }
  if (!state || typeof state !== 'object') return null
  const settled = state as Record<string, unknown>
  const status = settled['status']
  // Only a settled mutation can be evidence; a call still in flight has no result.
  if (status !== 'completed' && status !== 'error') return null
  const input = settled['input']
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const callID = record['callID']
  const title = settled['title']
  return {
    type: 'tool',
    id,
    messageID,
    callID: typeof callID === 'string' ? callID : id,
    tool,
    state: {
      status,
      input: input as Record<string, unknown>,
      ...(typeof title === 'string' ? { title } : {})
    }
  }
}
