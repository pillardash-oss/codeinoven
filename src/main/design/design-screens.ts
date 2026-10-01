import { readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DesignScreen } from '../../lib/ipc/design'
import { SERVED_FOLDER_ENTRY_FILE } from '../preview/served-folder'

/**
 * The screens of one design, read from the folder the design lives in.
 *
 * A design is a product rather than a page: a website is several pages and a
 * dashboard is several screens, and each of them is a file a preview can be
 * aimed at with its `entry` argument. The board needs that list to show a
 * picture per screen, so the listing is a read of the folder rather than a
 * manifest an agent has to remember to write: a screen is an `.html` file in the
 * design folder or in one folder below it (`pages/pricing.html`), which is the
 * layout the capability's playbook states.
 *
 * Kept free of the database and of IPC so the rule can be exercised on its own,
 * and shared by the surface that lists screens and the one that captures them,
 * because a second copy is how the gallery and the sweep disagree about what a
 * screen is.
 */

/**
 * Most screens one folder is listed with.
 *
 * A ceiling rather than a rule: the board captures a picture per screen, and an
 * unbounded list would turn one panel open into an unbounded run of page loads.
 */
export const MAX_DESIGN_SCREENS = 24

/** Only files the app's own entry file convention can show are screens. */
const SCREEN_EXTENSION = '.html'

/**
 * A name starting with `.` is hidden by convention, and one starting with `_` is
 * a partial rather than a screen: `_nav.html` is included by the pages around it
 * and has no state or layout of its own to picture.
 */
function isListableName(name: string): boolean {
  return !name.startsWith('.') && !name.startsWith('_')
}

/** A screen's label: its path inside the folder without the extension. */
function screenName(entry: string): string {
  return entry.slice(0, entry.length - SCREEN_EXTENSION.length)
}

interface FoundFile {
  /** Path inside the design folder, as a preview `entry` spells it. */
  entry: string
  updatedAt: number
}

/** The `.html` files of one folder, alphabetically and without following errors. */
async function htmlFilesIn(directory: string, prefix: string): Promise<FoundFile[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const found: FoundFile[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !isListableName(entry.name)) continue
    if (!entry.name.toLowerCase().endsWith(SCREEN_EXTENSION)) continue
    const info = await stat(resolve(directory, entry.name)).catch(() => null)
    if (info === null) continue
    found.push({
      entry: `${prefix}${entry.name}`,
      updatedAt: Math.round(info.mtimeMs)
    })
  }
  return found.sort((left, right) => left.entry.localeCompare(right.entry))
}

/** The folder names one level below, which is the only other place a screen lives. */
async function screenFoldersIn(absoluteFolder: string): Promise<string[]> {
  const entries = await readdir(absoluteFolder, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory() && isListableName(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
}

/** The entry file first, because everything else in the design hangs off it. */
function entryFileFirst(files: FoundFile[]): FoundFile[] {
  const index = files.findIndex((file) => file.entry === SERVED_FOLDER_ENTRY_FILE)
  if (index <= 0) return files
  const [entry] = files.splice(index, 1)
  return entry === undefined ? files : [entry, ...files]
}

/**
 * Every screen of one design, in the order the board shows them.
 *
 * The folder's own pages come first with `index.html` leading, then the pages one
 * folder below, and the list is cut at {@link MAX_DESIGN_SCREENS}. A folder that
 * is not there, or one holding no HTML at all, answers with no screens rather
 * than throwing: an unfinished design is the normal state of a design somebody is
 * about to write into.
 */
export async function listDesignScreens(absoluteFolder: string): Promise<DesignScreen[]> {
  const own = entryFileFirst(await htmlFilesIn(absoluteFolder, ''))
  const nested: FoundFile[] = []
  for (const folder of await screenFoldersIn(absoluteFolder)) {
    nested.push(...(await htmlFilesIn(resolve(absoluteFolder, folder), `${folder}/`)))
  }
  return [...own, ...nested].slice(0, MAX_DESIGN_SCREENS).map(({ entry, updatedAt }) => ({
    entry,
    name: screenName(entry),
    updatedAt
  }))
}
