/**
 * How one design path is handed to an agent.
 *
 * A design is a folder on a machine, and the right path to give depends on where
 * the asking agent is. The composer resolves an `@` tag against the thread's own
 * scope root, so a tag is only correct when the thread runs in the same project,
 * on the same machine, at the project root. A thread in a managed worktree has
 * its own checkout that does not hold the project's `.cio`, and a thread on
 * another Oven cannot see this machine's filesystem at all. In those cases the
 * absolute path is the honest answer, and for another Oven it has to be the
 * absolute path on that Oven plus the way to reach it, because the agent has to
 * go and get the file rather than open it where it stands.
 *
 * The decision is pure so it can be reasoned about and exercised on its own; the
 * store-reading wrapper lives in `design-copy-context.ts`.
 */

import { LOCAL_OVEN_ID, type Oven } from '$shared/ovens'
import type { Project, Thread } from '$shared/types'

/** Which form of the path was produced, for the caller's toast. */
export type DesignCopyMode = 'relative' | 'absolute' | 'oven'

export interface DesignCopyPayload {
  /** The text to put on the clipboard. */
  text: string
  mode: DesignCopyMode
  /** What the copy toast says. */
  message: string
}

/** The context a copy decision is made from. */
export interface DesignCopyContext {
  project: Project
  thread: Thread | null
  /** The Oven the current thread runs on, or null for this device. */
  threadOven: Oven | null
  /** The Oven the project's files live on, or null for this device. */
  projectOven: Oven | null
  /** Whether the current thread's scope root is the project directory itself. */
  threadScopeIsProject: boolean
}

/** Project-relative path of a design folder, or of a file inside it. */
export function designRelativePath(directory: string, entry?: string | null): string {
  const folder = trimSlashes(directory)
  const file = trimSlashes(entry ?? '')
  return file === '' ? folder : `${folder}/${file}`
}

/** The same path on the machine the project's files live on. */
export function designAbsolutePath(
  projectPath: string,
  directory: string,
  entry?: string | null
): string {
  const base = projectPath.replace(/\/+$/u, '')
  return `${base}/${designRelativePath(directory, entry)}`
}

/**
 * The path to hand an agent for one design or one of its screens.
 *
 * Same project, same scope root, same machine: an `@` tag the composer resolves.
 * Same machine but a different scope: the absolute path, which the agent can
 * read directly. A different machine: the absolute path on that machine plus the
 * way to reach it, so the agent fetches the file instead of reaching for a path
 * its own filesystem does not have.
 */
export function designCopyPayload(
  context: DesignCopyContext,
  directory: string,
  entry?: string | null
): DesignCopyPayload {
  const relative = designRelativePath(directory, entry)
  const absolute = designAbsolutePath(context.project.path, directory, entry)
  const targetOvenId = context.project.ovenId ?? LOCAL_OVEN_ID
  const threadOvenId = context.thread?.settings?.ovenId ?? LOCAL_OVEN_ID
  const sameOven = threadOvenId === targetOvenId
  const sameProject = context.thread?.projectId === context.project.id

  if (sameOven && sameProject && context.threadScopeIsProject) {
    return {
      text: `@${relative}`,
      mode: 'relative',
      message: 'Tag copied. Paste it into the composer to tag the design.'
    }
  }
  if (sameOven) {
    return { text: absolute, mode: 'absolute', message: 'Absolute path copied.' }
  }
  const oven = context.projectOven
  const name = oven?.name ?? targetOvenId
  return {
    text: `This design lives on the Oven "${name}", not on this machine.${ovenReach(oven, name)} Read it there:\n${absolute}`,
    mode: 'oven',
    message: 'Oven path copied.'
  }
}

/** The connecting sentence for a design that lives on another Oven. */
function ovenReach(oven: Oven | null, name: string): string {
  const connection = oven?.connection
  const host = connection?.host ?? oven?.id
  if (!host) return ` Connect to the Oven "${name}" and`
  const user = connection?.user ? `${connection.user}@` : ''
  const port = connection?.port && connection.port !== 22 ? ` -p ${connection.port}` : ''
  return ` Connect with \`ssh ${user}${host}${port}\` and`
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/u, '').replace(/\/+$/u, '')
}
