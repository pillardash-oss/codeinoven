import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type {
  PrAgentAssignmentInput,
  PrAgentAssignmentKind,
  PrAgentAssignmentSummary,
  PrAgentAssignmentWorkspace,
  PrAgentReport
} from '../../lib/types'

/**
 * Agent assignments on a pull request: one thread, one report, one sidecar.
 *
 * A pull request can hold several assignments at once, a triage and then one for
 * each comment handed to an agent, so every assignment keeps its own
 * `review-<id>.md` and `review-<id>.json` inside the pull request's directory.
 * The single `review.md` the first version of this feature wrote is still read:
 * reports already on disk are the user's work and must not vanish from the reader
 * just because the layout moved on.
 */

/** The pre-assignment layout: `review.md` plus `thread.json`. Read, never written. */
const LEGACY_ID = 'legacy'
const LEGACY_REPORT_FILE = 'review.md'
const LEGACY_THREAD_FILE = 'thread.json'

const REPORT_PATTERN = /^review-([0-9a-fA-F-]{36})\.md$/u
const META_PATTERN = /^review-([0-9a-fA-F-]{36})\.json$/u

/** The sidecar an assignment writes beside its report. */
interface AssignmentMeta {
  kind: PrAgentAssignmentKind
  title: string
  url: string | null
  threadId: string | null
  /** Epoch ms the assignment was made, or null for the pre-assignment layout. */
  createdAt: number | null
}

function directoryFor(projectPath: string, pullNumber: number): string {
  return join(projectPath, '.cio', 'git', 'pr', String(pullNumber))
}

function reportFile(id: string): string {
  return id === LEGACY_ID ? LEGACY_REPORT_FILE : `review-${id}.md`
}

function metaFile(id: string): string {
  return `review-${id}.json`
}

/** Read one JSON file, treating anything unreadable or malformed as absent. */
async function readJson(path: string): Promise<unknown> {
  return readFile(path, 'utf-8')
    .then((raw): unknown => JSON.parse(raw))
    .catch(() => null)
}

/** Every assignment id the directory holds, whether or not it has a report yet. */
function assignmentIds(entries: Dirent[]): string[] {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const report = REPORT_PATTERN.exec(entry.name)?.[1]
    if (report) ids.add(report)
    const meta = META_PATTERN.exec(entry.name)?.[1]
    if (meta) ids.add(meta)
    if (entry.name === LEGACY_REPORT_FILE || entry.name === LEGACY_THREAD_FILE) ids.add(LEGACY_ID)
  }
  return [...ids]
}

/**
 * One assignment's sidecar.
 *
 * Every field is read defensively: this file is inside the user's project, so a
 * hand-edited or truncated sidecar has to degrade to a usable assignment rather
 * than break the reader for the whole pull request.
 */
async function readMeta(directory: string, id: string): Promise<AssignmentMeta> {
  if (id === LEGACY_ID) {
    const record = await readJson(join(directory, LEGACY_THREAD_FILE))
    const threadId =
      typeof record === 'object' && record !== null
        ? (record as Record<string, unknown>)['threadId']
        : null
    return {
      kind: 'triage',
      title: 'Agent review',
      url: null,
      threadId: typeof threadId === 'string' ? threadId : null,
      createdAt: null
    }
  }
  const record = await readJson(join(directory, metaFile(id)))
  const fields =
    typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {}
  const title = fields['title']
  const url = fields['url']
  const threadId = fields['threadId']
  const createdAt = fields['createdAt']
  const kind = fields['kind']
  return {
    kind: kind === 'comment' || kind === 'check' ? kind : 'triage',
    title: typeof title === 'string' && title.length > 0 ? title : 'Agent assignment',
    url: typeof url === 'string' ? url : null,
    threadId: typeof threadId === 'string' ? threadId : null,
    createdAt: typeof createdAt === 'number' ? createdAt : null
  }
}

/** One assignment, with whatever its report currently says. */
async function readAssignment(directory: string, id: string): Promise<PrAgentReport> {
  const meta = await readMeta(directory, id)
  const path = join(directory, reportFile(id))
  const [content, stats] = await Promise.all([
    readFile(path, 'utf-8').catch(() => ''),
    stat(path).catch(() => null)
  ])
  return {
    id,
    kind: meta.kind,
    title: meta.title,
    path,
    content,
    updatedAt: stats?.mtimeMs ?? null,
    createdAt: meta.createdAt,
    threadId: meta.threadId,
    url: meta.url
  }
}

/** Newest assignment first: the list reads in the order the user made them. */
function newestFirst(left: PrAgentReport, right: PrAgentReport): number {
  return (right.createdAt ?? 0) - (left.createdAt ?? 0)
}

/** When an assignment was made, with the pre-assignment layout counting as oldest. */
function recency(meta: AssignmentMeta): number {
  return meta.createdAt ?? 0
}

/** Open a new assignment and hand back the report path its brief should name. */
export async function createPrAgentAssignment(
  projectPath: string,
  pullNumber: number,
  threadId: string,
  input: PrAgentAssignmentInput
): Promise<PrAgentAssignmentWorkspace> {
  const directory = directoryFor(projectPath, pullNumber)
  await mkdir(directory, { recursive: true })
  const id = randomUUID()
  const meta: AssignmentMeta = {
    kind: input.kind,
    title: input.title,
    url: input.url ?? null,
    threadId,
    createdAt: Date.now()
  }
  await writeFile(join(directory, metaFile(id)), JSON.stringify(meta, null, 2), 'utf-8')
  return { id, directory, reportPath: join(directory, reportFile(id)) }
}

/** Every assignment on one pull request, newest first. */
export async function listPrAgentReports(
  projectPath: string,
  pullNumber: number
): Promise<PrAgentReport[]> {
  const directory = directoryFor(projectPath, pullNumber)
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const reports = await Promise.all(
    assignmentIds(entries).map((id) => readAssignment(directory, id))
  )
  return reports.sort(newestFirst)
}

/**
 * What a page of rows needs to know, without reading a single report.
 *
 * One directory listing and one sidecar per assignment per pull request, read in
 * sequence rather than all at once: this runs on every page of the list, and the
 * cost that matters here is not latency on one row but never letting a page of
 * twenty rows turn into a burst of disk work.
 */
export async function summarizePrAgentAssignments(
  projectPath: string,
  numbers: number[]
): Promise<Record<string, PrAgentAssignmentSummary>> {
  const summaries: Record<string, PrAgentAssignmentSummary> = {}
  for (const pullNumber of numbers) {
    const directory = directoryFor(projectPath, pullNumber)
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    const ids = assignmentIds(entries)
    if (ids.length === 0) continue
    const metas = await Promise.all(ids.map((id) => readMeta(directory, id)))
    const newest = metas.reduce((latest, meta) => (recency(meta) > recency(latest) ? meta : latest))
    summaries[String(pullNumber)] = {
      count: ids.length,
      threadId: newest.threadId,
      title: newest.title,
      createdAt: newest.createdAt
    }
  }
  return summaries
}
