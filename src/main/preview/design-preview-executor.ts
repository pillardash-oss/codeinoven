import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { requireLocalProject } from '../../lib/project-artifacts'
import { DESIGN_OUTPUT_ROOT } from '../../lib/design-skill'
import type { BrowserService } from '../browser/browser-service'
import type { Database } from '../database/database'
import type { DesignCapabilityExecutor } from '../utilities/utility-orchestration-service'
import type { DirectoryPreviewService } from './directory-preview-service'

/** Ceilings on the path fields, so a hand-written call cannot inflate a log line. */
const MAX_DIRECTORY_LENGTH = 1_024
const MAX_ENTRY_LENGTH = 512

/** File the folder is expected to hold, and the one a preview falls back to. */
const DESIGN_ENTRY_FILE = 'index.html'

/**
 * What the design capability needs from the app.
 *
 * The browser is supplied as a getter because the service exists only while the
 * app has a window to host tabs in. Serving the folder must still work without
 * one, so a missing browser degrades to a URL rather than a failure.
 */
export interface DesignPreviewExecutorOptions {
  previews: DirectoryPreviewService
  database: Database
  browser: () => BrowserService | null
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** One project-relative folder, defaulted and refused when it could escape. */
function resolveDirectory(
  projectPath: string,
  raw: unknown
): { absolute: string; display: string } {
  let requested = DESIGN_OUTPUT_ROOT
  if (raw !== undefined) {
    if (typeof raw !== 'string') throw new Error('directory must be a project-relative path')
    const trimmed = raw.trim()
    if (trimmed.length > MAX_DIRECTORY_LENGTH) throw new Error('directory is too long')
    if (trimmed.length > 0) requested = trimmed
  }
  if (isAbsolute(requested)) throw new Error('directory must be relative to the project')
  const absolute = resolve(projectPath, requested)
  if (!isInside(projectPath, absolute)) {
    throw new Error(
      'directory must be a folder inside the project, and not the project root itself'
    )
  }
  return { absolute, display: relative(projectPath, absolute).split(sep).join('/') }
}

/** One file inside the served folder, or null to let the folder listing show. */
function resolveEntry(
  raw: unknown
): { requested: string; segments: string[]; absolute: string } | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'string') throw new Error('entry must be a path inside the served folder')
  const requested = raw.trim()
  if (requested.length === 0) return null
  if (requested.length > MAX_ENTRY_LENGTH) throw new Error('entry is too long')
  if (isAbsolute(requested) || /^[a-zA-Z]:/u.test(requested)) {
    throw new Error('entry must be relative to the served folder')
  }
  const segments = requested.split(/[\\/]+/u).filter((segment) => segment.length > 0)
  if (segments.length === 0 || segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error('entry must name a file inside the served folder')
  }
  return { requested, segments, absolute: resolve(...segments) }
}

async function existsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Run the app-owned design capability's `preview` operation.
 *
 * The service behind this is the same loopback static host the file explorer
 * uses for "Open in browser" (`src/main/preview/directory-preview-server.ts`),
 * so a design renders with its own scripts and stylesheets running and with no
 * content security policy of its own. What the agent gets back is the URL, plus
 * the thread's browser tab showing it, and then the in-app browser capability's
 * `screenshot`, `viewport`, `snapshot` and `console` operations apply to that
 * tab without any new machinery here.
 */
export function createDesignPreviewExecutor(
  options: DesignPreviewExecutorOptions
): DesignCapabilityExecutor {
  // Which project and thread pairs already have a preview tab, so a design that
  // changes twenty times reloads one tab instead of opening twenty. The browser
  // is still the authority: if it let the tab go, the navigate below fails and
  // the open that follows makes a new one.
  const previewed = new Set<string>()
  return async (operation, input, context) => {
    if (operation !== 'preview') {
      throw new Error(
        `The design capability exposes one operation, "preview", and no operation named "${operation}".`
      )
    }
    const project = requireLocalProject(options.database, context.projectId)
    const directory = resolveDirectory(project.path, input['directory'])
    const requested = resolveEntry(input['entry'])
    const registration = await options.previews.open(directory.absolute).catch((error: unknown) => {
      throw new Error(
        `The design folder "${directory.display}" is not there yet. Write the design into it first, or name a folder that exists. Underlying error: ${error instanceof Error ? error.message : String(error)}`
      )
    })

    let entry = requested
    if (entry) {
      const absolute = resolve(directory.absolute, ...entry.segments)
      if (!isInside(directory.absolute, absolute)) {
        throw new Error('entry must name a file inside the served folder')
      }
      if (!(await existsAsFile(absolute))) {
        throw new Error(`The served folder has no file named "${entry.requested}".`)
      }
      entry = { ...entry, absolute }
    } else if (await existsAsFile(resolve(directory.absolute, DESIGN_ENTRY_FILE))) {
      entry = {
        requested: DESIGN_ENTRY_FILE,
        segments: [DESIGN_ENTRY_FILE],
        absolute: resolve(directory.absolute, DESIGN_ENTRY_FILE)
      }
    }

    const url = entry
      ? `${registration.url}${entry.segments.map((segment) => encodeURIComponent(segment)).join('/')}`
      : registration.url
    const attention = input['attention'] === 'background' ? 'background' : 'focus'
    const browser = options.browser()
    const tabKey = `${context.projectId}\u0000${context.threadId}`
    let tab: 'reused' | 'opened' | null = null
    if (browser) {
      const target = { projectId: context.projectId, threadId: context.threadId }
      try {
        if (!previewed.has(tabKey)) throw new Error('no preview tab yet')
        // One agent tab per thread is the browser service's own model, so a
        // second preview navigates the tab the first one opened.
        await browser.executeUtility('navigate', { url }, target)
        tab = 'reused'
      } catch {
        await browser.executeUtility('open', { url, attention }, target)
        previewed.add(tabKey)
        tab = 'opened'
      }
    }

    return {
      url,
      directory: directory.display,
      entry: entry?.requested ?? null,
      served: entry ? 'file' : 'folder listing',
      attention,
      tab,
      note: tab
        ? 'Activate the in-app browser capability to screenshot this tab, change its viewport, or read its console.'
        : 'No browser tab was opened, so this URL is for the user to open while the app is running.'
    }
  }
}
