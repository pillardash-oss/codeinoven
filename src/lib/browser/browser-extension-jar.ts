import { GLOBAL_BROWSER_PROJECT_ID } from '../types/project'
import { DEFAULT_BOX_ID } from './global-browser-tabs'

/**
 * The extension jar one context's browser runs in.
 *
 * A jar is a session: cookies, cache, and the extensions loaded into it. This app
 * has three kinds of them, and an extension record names the ones it runs in:
 *
 *   - a **box**, drawn by its box id. A box is one identity of the profile rather
 *     than of a context, so every context that picks that box joins the same jar,
 *     extensions included.
 *   - the **profile's own jar**, which the record spells as the empty string. The
 *     global browser browsing unboxed and any context that picked the profile's own
 *     box both live there, because a box's jar and the profile's jar are the same
 *     profile.
 *   - a **context's own jar**, drawn by that context. It belongs to one project (or
 *     one space), which is what makes an extension installed beside a project's
 *     conversation that project's alone: it is loaded while one of that project's
 *     tabs is open, it survives every tab being closed, and it goes when the
 *     project does.
 *
 * The empty string used to stand for both of the last two, which is what made an
 * extension installed in one context's own jar look like a global one. Naming the
 * context here is what separates them.
 */
export const PROJECT_EXTENSION_JAR_PREFIX = 'project:'

/**
 * The jar one context's browser uses.
 *
 * `boxId` is the tab's own box, or null for the context's own jar. A context that
 * picked the profile's own box browses the profile's jar, which is the same jar the
 * global browser's unboxed pages use; that is a choice the box control offers on
 * purpose, because it is how a conversation browses as the person.
 */
export function extensionJarIdFor(projectId: string, boxId: string | null): string {
  if (boxId !== null) return boxId === DEFAULT_BOX_ID ? '' : boxId
  if (projectId === GLOBAL_BROWSER_PROJECT_ID) return ''
  return `${PROJECT_EXTENSION_JAR_PREFIX}${projectId}`
}

/** Whether a jar id names one context's own jar rather than a box or the profile's. */
export function isProjectExtensionJar(jarId: string): boolean {
  return jarId.startsWith(PROJECT_EXTENSION_JAR_PREFIX)
}

/** The context a project jar belongs to, or null for any other kind of jar. */
export function projectIdOfExtensionJar(jarId: string): string | null {
  if (!isProjectExtensionJar(jarId)) return null
  const projectId = jarId.slice(PROJECT_EXTENSION_JAR_PREFIX.length)
  return projectId.length > 0 ? projectId : null
}

/**
 * The jar id of one project's own jar, for the paths that name the owner rather
 * than a tab: a project being deleted, or the sweep that reclaims what a removed
 * one left behind.
 */
export function projectExtensionJar(projectId: string): string {
  return `${PROJECT_EXTENSION_JAR_PREFIX}${projectId}`
}

/**
 * The context and box a jar id resolves to, for the paths that work the other way:
 * releasing a jar's session, or removing a jar from every extension record.
 *
 * The profile's own jar is the global context unboxed, and a box's jar is the
 * profile's whichever context picked it, so everything that is not one context's
 * own jar resolves under the global context. That is the same answer the partition
 * naming gives, which is what stops the two from disagreeing about whose jar a
 * session is.
 */
export function extensionJarTarget(jarId: string): {
  projectId: string
  boxId: string | null
} {
  const owner = projectIdOfExtensionJar(jarId)
  if (owner !== null) return { projectId: owner, boxId: null }
  return { projectId: GLOBAL_BROWSER_PROJECT_ID, boxId: jarId === '' ? null : jarId }
}
