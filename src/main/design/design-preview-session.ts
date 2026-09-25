import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { BrowserDesignTab } from '../../lib/ipc/browser'
import type { BrowserService } from '../browser/browser-service'
import type { DirectoryPreviewService } from '../preview/directory-preview-service'
import { isInsideProject, resolveDesignDirectory } from './design-paths'

/**
 * One way to put a design on screen.
 *
 * Two callers need it: the design capability's `preview` operation, which the
 * agent runs, and the design coordinator's open and thumbnail actions, which the
 * user runs. Both must serve the folder on the same loopback origin, show it in
 * the same thread tab, and mark that tab as a design so the element inspector
 * arms. A second copy of this would let the two drift, so it lives here.
 */

/** Ceiling on the entry field, so a hand-written call cannot inflate a log line. */
const MAX_ENTRY_LENGTH = 512

/** File the folder is expected to hold, and the one a preview falls back to. */
export const DESIGN_ENTRY_FILE = 'index.html'

export interface DesignPreviewDeps {
  previews: DirectoryPreviewService
  /** Read lazily: the service exists only while the app has a window to host tabs. */
  browser: () => BrowserService | null
}

export interface DesignPreviewRequest {
  projectPath: string
  projectId: string
  threadId: string
  /**
   * Project-relative folder, as the caller spelled it. Validated here rather
   * than at each call site, so the agent's untrusted input and the coordinator's
   * IPC argument go through one check.
   */
  directory: unknown
  /** Project-relative entry inside the folder, or null/undefined for the default. */
  entry: unknown
  /** How the capability's own open behaves when it has to create the tab. */
  attention: 'focus' | 'background'
  /** Bring the tab to the user even when it already existed. */
  reveal: boolean
}

export interface DesignPreviewResult {
  /** Project-relative folder, with forward slashes. */
  directory: string
  /** Entry file shown, or null for the folder listing. */
  entry: string | null
  url: string
  origin: string
  served: 'file' | 'folder listing'
  tab: 'reused' | 'opened' | null
  tabId: string | null
}

interface ResolvedEntry {
  requested: string
  segments: string[]
  absolute: string
}

async function existsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Reject an entry that could name anything outside the served folder. */
function parseEntry(raw: string): ResolvedEntry {
  if (raw.length > MAX_ENTRY_LENGTH) throw new Error('entry is too long')
  if (isAbsolute(raw) || /^[a-zA-Z]:/u.test(raw)) {
    throw new Error('entry must be relative to the served folder')
  }
  const segments = raw.split(/[\\/]+/u).filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('entry must name a file inside the served folder')
  }
  return { requested: raw, segments, absolute: resolve(...segments) }
}

/**
 * The entry file to show, or null to let the folder listing show.
 *
 * A named entry must exist, because serving a listing for a file the caller
 * named would hide the mistake. With no entry named, `index.html` is used when
 * the folder has one.
 */
async function resolveEntry(
  directoryAbsolute: string,
  raw: unknown
): Promise<ResolvedEntry | null> {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new Error('entry must be a path inside the served folder')
  }
  const requested = typeof raw === 'string' ? raw.trim() : ''
  if (requested.length === 0) {
    return (await existsAsFile(resolve(directoryAbsolute, DESIGN_ENTRY_FILE)))
      ? parseEntry(DESIGN_ENTRY_FILE)
      : null
  }
  const parsed = parseEntry(requested)
  const absolute = resolve(directoryAbsolute, ...parsed.segments)
  if (!isInsideProject(directoryAbsolute, absolute)) {
    throw new Error('entry must name a file inside the served folder')
  }
  if (!(await existsAsFile(absolute))) {
    throw new Error(`The served folder has no file named "${requested}".`)
  }
  return { ...parsed, absolute }
}

/** The tab id an in-app browser operation reported, or null when it reported none. */
function tabIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const tabId = (result as Record<string, unknown>)['tabId']
  return typeof tabId === 'string' && tabId.length > 0 ? tabId : null
}

/**
 * Serve one design folder and show it in the project and thread's browser tab.
 *
 * The thread has one agent tab, so a preview of a folder the thread already has
 * open navigates that tab instead of stacking a second one; the browser is the
 * authority on whether it still exists, not a memo here.
 */
export async function openDesignPreview(
  deps: DesignPreviewDeps,
  request: DesignPreviewRequest
): Promise<DesignPreviewResult> {
  const directory = resolveDesignDirectory(request.projectPath, request.directory)
  const registration = await deps.previews.open(directory.absolute).catch((error: unknown) => {
    throw new Error(
      `The design folder "${directory.display}" is not there yet. Write the design into it first, or name a folder that exists. Underlying error: ${error instanceof Error ? error.message : String(error)}`
    )
  })
  const entry = await resolveEntry(directory.absolute, request.entry)
  const url = entry
    ? `${registration.url}${entry.segments.map((segment) => encodeURIComponent(segment)).join('/')}`
    : registration.url
  const origin = new URL(registration.url).origin
  const design: BrowserDesignTab = { directory: directory.display, origin }

  const browser = deps.browser()
  let tab: 'reused' | 'opened' | null = null
  let tabId: string | null = null
  if (browser) {
    const target = { projectId: request.projectId, threadId: request.threadId }
    if (browser.agentTabFor(request.projectId, request.threadId)) {
      tabId = tabIdOf(await browser.executeUtility('navigate', { url }, target))
      tab = 'reused'
    } else {
      tabId = tabIdOf(
        await browser.executeUtility('open', { url, attention: request.attention }, target)
      )
      tab = 'opened'
    }
    if (tabId) {
      // Marking the tab is what arms the element inspector: the panel offers
      // inspection only on a tab that is rendering a design.
      browser.markDesignTab(tabId, design)
      // The capability's own open reveals; a reused tab does not, so a design the
      // user asked for again is brought forward explicitly.
      if (request.reveal) browser.revealTab(tabId)
    }
  }

  return {
    directory: directory.display,
    entry: entry?.requested ?? null,
    url,
    origin,
    served: entry ? 'file' : 'folder listing',
    tab,
    tabId
  }
}
