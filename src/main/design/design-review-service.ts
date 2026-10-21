/// <reference types="electron-vite/node" />
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { relative, isAbsolute, join } from 'node:path'
import createReviewWorker from './design-review-worker.ts?nodeWorker'
import { currentWorkRoot } from './work-roots-state'
import type { Database } from '../database/database'
import { requireLocalProjectViaWorker } from '../../lib/project-artifacts'
import { resolveServedFolder, resolveServedEntry } from '../preview/served-folder'
import {
  DESIGN_REVIEW_DIMENSIONS,
  DESIGN_REVIEW_RUBRIC,
  DESIGN_REVIEW_THRESHOLD,
  type DesignCraftReport,
  type DesignReviewAssessment
} from '../../lib/design/design-review'
import { VIDEO_REVIEW_RUBRIC, validateVideoReviewEvidence } from '../../lib/video/review'
import { snapshotVideoSource } from '../video/video-evidence'
import { loadCompositionManifest } from '../video/video-manifest'

export async function runDesignReview(
  database: Database,
  context: { projectId: string; threadId: string },
  input: Record<string, unknown>,
  critique: boolean,
  kind: 'design' | 'video' = 'design'
): Promise<unknown> {
  const project = await requireLocalProjectViaWorker(database, context.projectId)
  const folder = resolveServedFolder(
    project.path,
    input['directory'],
    currentWorkRoot(kind, context.projectId)
  )
  const canonicalFolder = await realpath(folder.absolute)
  const canonicalProject = await realpath(project.path)
  const within = relative(canonicalProject, canonicalFolder)
  if (within.startsWith('..') || isAbsolute(within))
    throw new Error('Review folder escapes the project')
  if (typeof input['entry'] !== 'string' || !input['entry'].trim())
    throw new Error('Review requires an entry file')
  const entry = await resolveServedEntry(canonicalFolder, input['entry'])
  if (!entry) throw new Error('Review requires an entry file')
  const file = await realpath(entry.absolute)
  const relativeFile = relative(canonicalFolder, file)
  if (relativeFile.startsWith('..') || isAbsolute(relativeFile))
    throw new Error('Review entry escapes the authored-work folder')
  let reviewEvidence: ReturnType<typeof validateVideoReviewEvidence> | undefined
  let craft: DesignCraftReport
  if (kind === 'video') {
    if ((await stat(join(canonicalFolder, 'composition.json'))).size > 64 * 1024)
      throw new Error('Video critique accepts manifests up to 64 KiB')
    const manifest = await loadCompositionManifest(canonicalFolder, folder.display)
    reviewEvidence = validateVideoReviewEvidence(
      input['reviewEvidence'],
      manifest.duration,
      manifest.fps
    )
    const source = await snapshotVideoSource(canonicalFolder, new AbortController().signal)
    craft = { hash: source.sha256, findings: [] }
  } else
    craft = await new Promise<DesignCraftReport>((resolve, reject) => {
      const worker = createReviewWorker({ workerData: file })
      let settled = false
      const finish = (error: Error | null, result?: DesignCraftReport): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void worker.terminate()
        if (error) reject(error)
        else resolve(result!)
      }
      const timer = setTimeout(() => finish(new Error('Craft review timed out')), 15_000)
      worker.on('message', (message: { error?: string; result?: DesignCraftReport }) =>
        finish(message.error ? new Error(message.error) : null, message.result)
      )
      worker.on('error', (error: Error) => finish(error))
      worker.on('exit', (code: number) => {
        if (!settled) finish(new Error(`Craft worker exited (${code})`))
      })
    })
  if (!critique) return craft
  const raw = input['dimensions']
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Critique requires the five rubric dimensions')
  const dimensions: Record<string, DesignReviewAssessment> = {}
  for (const name of DESIGN_REVIEW_DIMENSIONS) {
    const value: unknown = (raw as Record<string, unknown>)[name]
    if (!value || typeof value !== 'object') throw new Error(`Missing ${name} assessment`)
    const { score, evidence } = value as Record<string, unknown>
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 10 ||
      typeof evidence !== 'string' ||
      !evidence.trim() ||
      evidence.length > 2000
    )
      throw new Error(`Invalid ${name} score or evidence`)
    dimensions[name] = { score, evidence }
  }
  const fixes = input['fixes']
  if (
    !Array.isArray(fixes) ||
    fixes.length > 30 ||
    fixes.some((fix) => typeof fix !== 'string' || fix.length > 1000)
  )
    throw new Error('fixes must be a list of at most 30 concrete corrections')
  const criticalIssues = input['criticalIssues']
  if (
    !Array.isArray(criticalIssues) ||
    criticalIssues.length > 30 ||
    criticalIssues.some((issue) => typeof issue !== 'string' || issue.length > 1000)
  )
    throw new Error(
      'criticalIssues must list any unresolved functionality, brand, accessibility or copy failures'
    )
  const score =
    Math.round(
      (DESIGN_REVIEW_DIMENSIONS.reduce((sum, name) => sum + dimensions[name]!.score, 0) / 5) * 100
    ) / 100
  const passed =
    score >= DESIGN_REVIEW_THRESHOLD && craft.findings.length === 0 && criticalIssues.length === 0
  const threadResult = await database.queryViaWorker(
    'SELECT provider_id, settings FROM threads WHERE id = ? AND project_id = ?',
    [context.threadId, context.projectId],
    1
  )
  if (!threadResult.ok || !threadResult.rows[0]) throw new Error('Review thread is unavailable')
  const row = threadResult.rows[0]
  const settings: Record<string, unknown> =
    typeof row['settings'] === 'string'
      ? (JSON.parse(row['settings']) as Record<string, unknown>)
      : {}
  const model = typeof settings['modelId'] === 'string' ? settings['modelId'] : 'unknown'
  const provider =
    typeof settings['providerId'] === 'string' ? settings['providerId'] : String(row['provider_id'])
  const harness = typeof settings['harnessId'] === 'string' ? settings['harnessId'] : 'unknown'
  const rubric = kind === 'video' ? VIDEO_REVIEW_RUBRIC : DESIGN_REVIEW_RUBRIC
  const id = createHash('sha256')
    .update(
      JSON.stringify([
        context.projectId,
        folder.display,
        entry.requested,
        craft.hash,
        harness,
        provider,
        model,
        rubric
      ])
    )
    .digest('hex')
  const report = {
    directory: folder.display,
    entry: entry.requested,
    rubric,
    ...(kind === 'video'
      ? {
          kind,
          reviewEvidence,
          limitations: [
            'Scores and viewing observations are agent-assessed, not independently verified.',
            'Screen HTML lint is not applied to video; visual and audio failures must be reported as critical issues.',
            'Source hashes cover local non-hidden files only; a critique does not approve an exported MP4.'
          ]
        }
      : {}),
    dimensions,
    score,
    threshold: DESIGN_REVIEW_THRESHOLD,
    passed,
    fixes,
    criticalIssues,
    craft,
    assessment: 'agent',
    model
  }
  const saved = await database.executeViaWorker(
    `INSERT INTO design_reviews(id, project_id, thread_id, harness, provider, model, rubric, score, passed, report, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET score=excluded.score, passed=excluded.passed, report=excluded.report, created_at=excluded.created_at`,
    [
      id,
      context.projectId,
      context.threadId,
      harness,
      provider,
      model,
      rubric,
      score,
      passed ? 1 : 0,
      JSON.stringify(report),
      Date.now()
    ],
    { allowPrimaryFallback: false }
  )
  if (!saved.ok) throw new Error(saved.error ?? `Could not persist ${kind} critique`)
  const retention = await database.executeViaWorker(
    'DELETE FROM design_reviews WHERE id IN (SELECT id FROM design_reviews ORDER BY created_at DESC LIMIT -1 OFFSET 5000)',
    [],
    { allowPrimaryFallback: false }
  )
  if (!retention.ok) throw new Error(retention.error ?? 'Could not bound design review history')
  return report
}
