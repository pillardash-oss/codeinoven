import { join } from 'node:path'

/**
 * One finished run's report, waiting for the thread it belongs to.
 *
 * A delegated report is the only thing that tells the agent which spawned the
 * work that it is done. Ten pawns finishing inside a few seconds of each other
 * used to hand ten prompts to one parent thread at once, and every prompt that
 * reached a turn already ending was wasted: the report was dropped, and the
 * thread it targeted was marked failed on the way out. The queue is what turns
 * "ten arrivals" into "one parent turn that reads all ten".
 */
export interface QueuedDelegationReport {
  schemaVersion: 1
  id: string
  projectId: string
  threadId: string
  /** Which delegation produced it, so a batch can say so in one line. */
  kind: 'pawn' | 'dispatch'
  /** The prompt text this report contributes to the turn that delivers it. */
  text: string
  /** The card the parent's conversation shows for this report. */
  action: string
  body: string
  createdAt: number
}

export interface DelegationReportQueue {
  schemaVersion: 1
  projectId: string
  threadId: string
  items: QueuedDelegationReport[]
}

/** Config-relative folder holding one file per waiting thread. */
export const DELEGATION_REPORT_QUEUE_DIR = 'delegation-report-queue'

/**
 * How many reports one parent turn reads at most.
 *
 * A batch is a compromise in both directions. Ten reports in one prompt is one
 * expensive turn reading everything at once and losing detail; ten turns is the
 * flood this queue exists to stop. Four keeps each turn's reading small enough
 * to act on and drains long queues over a few turns instead of failing.
 */
export const DELEGATION_REPORT_BATCH_MAX_ITEMS = 4

/** Character ceiling for one batch, so one verbose pawn cannot fill a turn. */
export const DELEGATION_REPORT_BATCH_MAX_CHARS = 40_000

/** Hard ceiling on a waiting queue; the oldest reports make room for new ones. */
export const MAX_QUEUED_DELEGATION_REPORTS = 200

export function delegationReportQueueKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

export function delegationReportQueuePath(projectId: string, threadId: string): string {
  return join(DELEGATION_REPORT_QUEUE_DIR, projectId, `${threadId}.json`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a persisted queue, rejecting anything that is not this queue.
 *
 * A file written by an older schema is dropped rather than guessed at: the
 * report it holds is already spent from the sender's point of view, and a
 * half-parsed queue would deliver a turn with a blank report in it.
 */
export function parseDelegationReportQueue(
  raw: unknown,
  projectId: string,
  threadId: string
): DelegationReportQueue {
  const empty: DelegationReportQueue = { schemaVersion: 1, projectId, threadId, items: [] }
  if (!isRecord(raw)) return empty
  if (raw.schemaVersion !== 1 || raw.projectId !== projectId || raw.threadId !== threadId) {
    return empty
  }
  if (!Array.isArray(raw.items)) return empty
  const items: QueuedDelegationReport[] = []
  for (const entry of raw.items) {
    if (!isRecord(entry)) continue
    if (entry.schemaVersion !== 1) continue
    const { id, kind, text, action, body, createdAt } = entry
    if (typeof id !== 'string' || id.length === 0) continue
    if (kind !== 'pawn' && kind !== 'dispatch') continue
    if (typeof text !== 'string' || text.length === 0) continue
    if (typeof action !== 'string') continue
    if (typeof body !== 'string') continue
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue
    items.push({
      schemaVersion: 1,
      id,
      projectId,
      threadId,
      kind,
      text,
      action,
      body,
      createdAt
    })
  }
  return { schemaVersion: 1, projectId, threadId, items }
}

/**
 * Split a queue into the reports one turn reads and the ones that wait.
 *
 * Oldest first, so a parent always hears the oldest news before the newest, and
 * a queue that keeps growing still drains in order.
 */
export function selectDelegationReportBatch(items: QueuedDelegationReport[]): {
  batch: QueuedDelegationReport[]
  rest: QueuedDelegationReport[]
} {
  const batch: QueuedDelegationReport[] = []
  let chars = 0
  for (const item of items) {
    if (batch.length >= DELEGATION_REPORT_BATCH_MAX_ITEMS) break
    if (batch.length > 0 && chars + item.text.length > DELEGATION_REPORT_BATCH_MAX_CHARS) break
    batch.push(item)
    chars += item.text.length
  }
  return { batch, rest: items.slice(batch.length) }
}

/**
 * One parent turn's text for a batch.
 *
 * A single report keeps its own card and its own words, because that is the
 * case a person reads most. A batch says how many reports it carries up front,
 * so the parent knows it is reading a digest and not one pawn's rambling, and
 * keeps every report's card body so nothing a pawn said is lost.
 */
export function composeDelegationReportTurn(batch: QueuedDelegationReport[]): {
  text: string
  action: string
  body: string
} {
  const first = batch[0]
  if (!first) return { text: '', action: '', body: '' }
  if (batch.length === 1) return { text: first.text, action: first.action, body: first.body }
  const pawns = batch.filter((item) => item.kind === 'pawn').length
  const runs = batch.length - pawns
  const counts = [
    pawns > 0 ? `${pawns} pawn ${pawns === 1 ? 'report' : 'reports'}` : '',
    runs > 0 ? `${runs} dispatched ${runs === 1 ? 'run' : 'runs'}` : ''
  ]
    .filter(Boolean)
    .join(' and ')
  return {
    text: [
      `${batch.length} delegated runs finished (${counts}). Each one is below; read all of them before you decide what to commit and what to re-run.`,
      ...batch.map((item) => item.text)
    ].join('\n\n---\n\n'),
    action: `Delegated work reported · ${batch.length} finished`.slice(0, 120),
    body: batch
      .map((item) => `## ${item.action}\n\n${item.body}`)
      .join('\n\n')
      .slice(0, 20_000)
  }
}
