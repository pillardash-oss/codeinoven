import { Preferences } from '@capacitor/preferences'

/**
 * The list of work is one destination with two readings: every thread, or every
 * project. A phone has one column, so the dock holds a single square for it and
 * that square opens whichever reading the person used last. The header of the
 * list itself is where the two are switched.
 */

export type WorkView = 'threads' | 'projects'

const KEY = 'cio.mobile.work-view'
const FIRST_VIEW: WorkView = 'threads'

export function workViewHref(view: WorkView): string {
  return view === 'projects' ? '/projects' : '/threads'
}

/** The reading this phone last used, defaulting to threads on a first open. */
export async function readWorkView(): Promise<WorkView> {
  try {
    const { value } = await Preferences.get({ key: KEY })
    return value === 'projects' ? 'projects' : FIRST_VIEW
  } catch {
    // A preference store that cannot be read is not a reason to refuse the app.
    return FIRST_VIEW
  }
}

/** Point the dock at this reading from now on. */
export async function rememberWorkView(view: WorkView): Promise<void> {
  try {
    await Preferences.set({ key: KEY, value: view })
  } catch {
    // Losing the preference costs one extra tap, never the navigation it follows.
  }
}
