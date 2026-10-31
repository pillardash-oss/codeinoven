/**
 * Bytes for a remote thread's media previews, and the checkout they come from.
 *
 * A video preview is served through the `appfile://` protocol as one range
 * request after another: the header, the tail (a file whose index sits at the
 * end needs it before the first frame), then every scrub. Each of those
 * requests used to resolve the thread's Oven and its checkout again, which
 * meant a database read and a root resolution per range. The route only changes
 * when a thread switches Oven, which cannot happen while a turn runs, so it is
 * resolved once and remembered until the thread's own row says otherwise.
 *
 * The bytes are never held: `read` pulls one 128 KiB chunk from the Oven on
 * demand, which is what the protocol streams to the renderer.
 */

import type { OvenThreadRoot } from './oven-thread-root'
import { resolveOvenThreadRoot } from './oven-thread-root'
import { subscribeThreadCorpus } from '../chat/thread-events'
import type { Thread } from '../../lib/types'
import type { OvenService } from './oven-service'
import type { ThreadManager } from '../../lib/engines/thread-manager'
import type { ProjectManager } from '../../lib/engines/project-manager'

/** One remote file, readable a chunk at a time from the thread's checkout. */
export interface OvenMediaReader {
  size: number
  read(offset: number): Promise<Uint8Array>
}

/** What the route needs to answer a preview read. */
export interface OvenMediaRouteDeps {
  /** The full service: resolving a thread's root also probes the Oven. */
  oven: OvenService
  threads: Pick<ThreadManager, 'getThread'>
  projects: Pick<ProjectManager, 'getProject'>
}

/** Bounded so a long session over many threads cannot grow it without limit. */
const MAX_ROUTES = 64

/**
 * Resolve a remote thread's checkout, or null when the thread works locally.
 *
 * The two callers are the `appfile://` protocol and the save-a-copy handler, so
 * both see one cached route per thread.
 */
export interface OvenMediaRoute {
  reader(projectId: string, threadId: string, path: string): Promise<OvenMediaReader | null>
}

interface RouteEntry {
  /** The thread's Oven identity when this route was resolved. */
  identity: string
  route: Promise<OvenThreadRoot | null>
}

function threadKey(projectId: string, threadId: string): string {
  return `${projectId}::${threadId}`
}

/** What a thread's route depends on: which Oven, and which checkout in it. */
function ovenIdentity(thread: Thread | null): string {
  return `${thread?.settings?.ovenId ?? 'local'}\u0000${thread?.settings?.ovenPath ?? ''}`
}

export function createOvenMediaRoute(deps: OvenMediaRouteDeps): OvenMediaRoute {
  const routes = new Map<string, RouteEntry>()

  const forget = (projectId: string, threadId: string): void => {
    routes.delete(threadKey(projectId, threadId))
  }

  // A thread's row is re-published whenever its settings are persisted, so this
  // is where an Oven switch invalidates the route that was resolved for the old
  // one. Status changes arrive here too and leave the route untouched.
  subscribeThreadCorpus({
    updated(thread) {
      const entry = routes.get(threadKey(thread.projectId, thread.id))
      if (entry && entry.identity !== ovenIdentity(thread)) forget(thread.projectId, thread.id)
    },
    deleted(thread) {
      forget(thread.projectId, thread.id)
    },
    draftUpdated() {
      // Drafting never moves a checkout.
    }
  })

  async function resolveRoute(projectId: string, threadId: string): Promise<OvenThreadRoot | null> {
    const key = threadKey(projectId, threadId)
    const cached = routes.get(key)
    if (cached) return await cached.route

    const entry: RouteEntry = { identity: '', route: Promise.resolve(null) }
    entry.route = (async () => {
      const thread = await deps.threads.getThread(projectId, threadId)
      entry.identity = ovenIdentity(thread)
      if (!thread?.settings?.ovenId || thread.settings.ovenId === 'local') return null
      return await resolveOvenThreadRoot(deps.oven, thread, deps.projects)
    })()

    routes.set(key, entry)
    if (routes.size > MAX_ROUTES) {
      const oldest = routes.keys().next().value
      if (oldest !== undefined && oldest !== key) routes.delete(oldest)
    }
    try {
      return await entry.route
    } catch (error) {
      // A failed resolution is not a route: a retry has to ask again.
      forget(projectId, threadId)
      throw error
    }
  }

  return {
    async reader(projectId, threadId, path) {
      const route = await resolveRoute(projectId, threadId)
      if (!route) return null
      const metadata = await deps.oven.workspace(route.ovenId, {
        operation: 'stat',
        root: route.root,
        path
      })
      const file = metadata.file
      if (file?.kind !== 'file') throw new Error('The remote preview is not a file.')
      return {
        size: file.size,
        read: async (offset) => {
          const chunk = await deps.oven.workspace(route.ovenId, {
            operation: 'read',
            root: route.root,
            path,
            offset
          })
          return new Uint8Array(Buffer.from(chunk.data ?? '', 'base64'))
        }
      }
    }
  }
}
