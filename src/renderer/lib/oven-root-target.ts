import type { Thread } from '$shared/types'
import { OVEN_ROOT_SCOPE_ARGUMENTS, ovenRootKeyFor } from '$shared/oven-root-routing'

/** One remote thread's checkout, as the renderer addressed it. */
export interface OvenRootBinding {
  projectId: string
  threadId: string
  ovenId: string
}

/**
 * How many scope keys stay resolvable.
 *
 * A panel keeps its scope key for the life of a session, and each entry is a
 * few dozen bytes, so the cap is only there to stop a pathological loop from
 * growing the map without bound.
 */
const MAX_BINDINGS = 128

let selectedThread: () => Thread | null = () => null
const bindings = new Map<string, OvenRootBinding>()

/** Read the selected thread at call time; navigation can never leave a stale target. */
export function bindOvenRootThread(reader: () => Thread | null): void {
  selectedThread = reader
}

/** The selected thread, when it is a remote thread of the given project. */
export function ovenRootThread(projectId?: string): Thread | null {
  const thread = selectedThread()
  const ovenId = thread?.settings?.ovenId
  if (!thread || !ovenId || ovenId === 'local') return null
  if (projectId && thread.projectId !== projectId) return null
  return thread
}

/**
 * The scope key a remote panel passes where a local scope bucket id goes.
 *
 * The key is registered here so a background save can still name the checkout
 * it was issued for after the user has selected a different Oven. Every store
 * keeps passing one scope argument; the invoke boundary is what recognizes it.
 */
export function ovenRootKey(projectId: string): string | null {
  const thread = ovenRootThread(projectId)
  const ovenId = thread?.settings?.ovenId
  if (!thread || !ovenId) return null
  const key = ovenRootKeyFor(thread.id, ovenId)
  bindings.set(key, { projectId: thread.projectId, threadId: thread.id, ovenId })
  if (bindings.size > MAX_BINDINGS) {
    const oldest = bindings.keys().next()
    if (!oldest.done) bindings.delete(oldest.value)
  }
  return key
}

/** Resolve a scope key back to its binding, refusing one from another project. */
export function boundOvenRoot(key: unknown, projectId: unknown): OvenRootBinding | null {
  if (typeof key !== 'string') return null
  const binding = bindings.get(key)
  return binding && binding.projectId === projectId ? binding : null
}

/** The receiver of one channel call, or null when the call stays on this computer. */
export function ovenRootTarget(channel: string, args: readonly unknown[]): OvenRootBinding | null {
  // Paste names both ends, so the destination key wins and the source key is the
  // fallback: a paste onto an Oven still runs on the Oven.
  if (channel === 'projectFiles:paste')
    return (
      boundOvenRoot(args[6], args[2]) ??
      boundOvenRoot(args[5], args[0]) ??
      selectedTarget(projectArgument(channel, args))
    )
  const bound = OVEN_ROOT_SCOPE_ARGUMENTS[channel]
  if (bound !== undefined) {
    const scoped = boundOvenRoot(args[bound], args[0])
    if (scoped) return scoped
  }
  return selectedTarget(projectArgument(channel, args))
}

/**
 * Arguments the main process expects for one routed channel.
 *
 * Most channels drop their project argument, which the main process re-derives.
 * Paste carries its own addressing for both sides, and a citation-path check
 * has no project argument at all.
 */
export function ovenRootArguments(channel: string, args: readonly unknown[]): unknown[] {
  if (channel === 'projectFiles:paste' || channel === 'projectFiles:resolveExternalCitationPaths')
    return [...args]
  return args.slice(1)
}

/** Project whose panels a channel call belongs to, when it names one. */
function projectArgument(channel: string, args: readonly unknown[]): string | undefined {
  if (channel.startsWith('repository:')) return undefined
  if (channel === 'projectFiles:paste') return stringArgument(args[2])
  if (channel === 'projectFiles:resolveExternalCitationPaths') return undefined
  return stringArgument(args[0])
}

function stringArgument(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The selected thread as a routing target, when it is a remote thread. */
function selectedTarget(projectId: string | undefined): OvenRootBinding | null {
  const thread = ovenRootThread(projectId)
  const ovenId = thread?.settings?.ovenId
  return thread && ovenId ? { projectId: thread.projectId, threadId: thread.id, ovenId } : null
}
