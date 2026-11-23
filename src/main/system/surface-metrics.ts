/**
 * Per-surface CPU and memory readout for the task manager.
 *
 * `app.getAppMetrics()` reports one row per OS process, and on a busy machine
 * several of those rows are renderer processes: a device-mirror stage, an
 * embedded browser tab, an extension's offscreen document, the workspace
 * window itself. The metrics alone cannot say which is which, so a hot renderer
 * has no owner and every investigation starts by guessing. Joining each
 * WebContents' OS pid to its metrics row is what turns "one process is at 90%"
 * into "the phone mirror stage is at 90%".
 *
 * The join lives in a pure function over plain shapes, so it is testable
 * without an Electron runtime, and the Electron reader is a thin, guarded
 * adapter on top of it.
 */

import { app, webContents } from 'electron'
import type { TaskManagerSurface, TaskManagerSurfaceKind } from '../../lib/types'
import { Logger } from './logger'

/** One OS process row as `app.getAppMetrics()` reports it. Plain shapes keep
 *  the join testable; the Electron shapes are structurally compatible. */
export interface SurfaceMetricProcess {
  pid: number
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number }
}

/** One live WebContents, already reduced to what a row needs to be readable. */
export interface SurfaceMetricContents {
  pid: number
  type: string
  title: string
  url: string
}

export interface SurfaceMetricsInput {
  metrics: ReadonlyArray<SurfaceMetricProcess>
  contents: ReadonlyArray<SurfaceMetricContents>
}

/** Electron reports `workingSetSize` in kibibytes; rows carry bytes. */
const KIBIBYTES_IN_BYTES = 1024

/**
 * A URL is shown so a row can be recognised, not copied: long deep links push
 * the title out of the row and can carry a one-time token in the query string.
 */
const MAX_URL_LENGTH = 200

/**
 * Label one WebContents with the surface a user recognises. Electron's own
 * types ('window', 'browserView', 'webview', 'backgroundPage', 'offscreen',
 * 'remote') name the implementation, not the thing on screen, so 'browserView'
 * reads as the tab it is drawn in and the offscreen/background pair collapses
 * into the one row a user thinks of as an extension document.
 */
function kindForWebContentsType(type: string): TaskManagerSurfaceKind {
  switch (type.trim().toLowerCase()) {
    case 'window':
      return 'window'
    case 'webview':
      return 'webview'
    case 'browserview':
      return 'tab'
    case 'offscreen':
    case 'backgroundpage':
      return 'offscreen'
    default:
      return 'other'
  }
}

/** Drop the query and hash but keep origin and path: enough to identify a
 *  surface, not enough to leak the token that may be in it. */
function originAndPath(url: string): string {
  const cut = url.search(/[?#]/u)
  return cut === -1 ? url : url.slice(0, cut)
}

/** Cut a label to a row-sized string. The front is kept because origin, and
 *  the start of the path, are the identifying part of a surface. */
function clampLabel(value: string): string {
  return value.length <= MAX_URL_LENGTH ? value : `${value.slice(0, MAX_URL_LENGTH - 1)}…`
}

/** Readable address of a surface: origin and path, no query, no hash, and the
 *  title when a surface has no address at all (an extension document). */
function sanitizeUrl(url: string, title: string): string {
  const readable = originAndPath(url.trim())
  return clampLabel(readable.length > 0 ? readable : title.trim())
}

const EMPTY_LABEL = 'Unnamed surface'

/**
 * Join WebContents to their process metrics, newest sample only.
 *
 * Rows are sorted by CPU so the hot renderer is the first thing read: the whole
 * point of the section is answering "which one" at a glance, and the modal caps
 * how many rows it draws.
 */
export function buildSurfaceMetrics(input: SurfaceMetricsInput): TaskManagerSurface[] {
  const metricsByPid = new Map<number, SurfaceMetricProcess>()
  for (const metric of input.metrics) {
    if (!Number.isSafeInteger(metric.pid) || metric.pid <= 0) continue
    metricsByPid.set(metric.pid, metric)
  }

  const surfaces: TaskManagerSurface[] = []
  const joinedPids = new Set<number>()
  for (const contents of input.contents) {
    const pid = contents.pid
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    // Two WebContents can be hosted by one renderer process. Reporting the
    // process twice would double-count the CPU the user is trying to attribute,
    // so the first surface that claims a pid owns it.
    if (joinedPids.has(pid)) continue
    const metric = metricsByPid.get(pid)
    if (!metric) continue
    joinedPids.add(pid)
    const url = sanitizeUrl(contents.url, contents.title)
    const title = clampLabel(contents.title.trim()) || url || EMPTY_LABEL
    surfaces.push({
      pid,
      kind: kindForWebContentsType(contents.type),
      title,
      url,
      cpuPercent: metric.cpu.percentCPUUsage,
      memoryBytes: metric.memory.workingSetSize * KIBIBYTES_IN_BYTES
    })
  }

  return surfaces.sort(
    (left, right) =>
      (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0) ||
      (right.memoryBytes ?? 0) - (left.memoryBytes ?? 0)
  )
}

/** Read one property of a WebContents that may die mid-read. A destroyed
 *  WebContents throws from every accessor, and losing one row is always better
 *  than losing the whole task-manager snapshot. */
function readContentsProperty(read: () => string): string {
  try {
    return read()
  } catch {
    return ''
  }
}

/**
 * Live renderer surfaces for the task-manager snapshot.
 *
 * Every step is guarded: this runs on the polling path of a modal, so a
 * WebContents destroyed between the list and the read must drop its row, never
 * reject the IPC that also carries every process and service.
 */
export function collectSurfaceMetrics(): TaskManagerSurface[] {
  let metrics: ReadonlyArray<SurfaceMetricProcess>
  try {
    metrics = app.getAppMetrics()
  } catch (error) {
    Logger.error('Reading app metrics for the surface readout failed:', error)
    return []
  }

  let entries: Electron.WebContents[]
  try {
    entries = webContents.getAllWebContents()
  } catch (error) {
    Logger.error('Listing web contents for the surface readout failed:', error)
    return []
  }

  const contents: SurfaceMetricContents[] = []
  for (const entry of entries) {
    try {
      if (entry.isDestroyed()) continue
      contents.push({
        pid: entry.getOSProcessId(),
        type: entry.getType(),
        title: readContentsProperty(() => entry.getTitle()),
        url: readContentsProperty(() => entry.getURL())
      })
    } catch {
      // A WebContents that dies mid-read is not a surface any more. Skipping it
      // keeps the rest of the readout intact instead of failing the snapshot.
      continue
    }
  }

  return buildSurfaceMetrics({ metrics, contents })
}
