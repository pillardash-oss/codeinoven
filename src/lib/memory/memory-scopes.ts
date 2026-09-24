import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '../types'
import type { MemoryAudience, MemoryEntry, MemoryScope } from '../types'

/**
 * Scope-set rules for persistent memory, shared by the main process (which
 * loads and stores entries) and the renderer (which edits them).
 *
 * A memory entry carries a set of scopes:
 *
 * - **Audience-level** - any subset of `MEMORY_AUDIENCES`, possibly empty. An
 *   empty set means every audience, which is what the UI calls "All audiences".
 *   These entries live in their audience's own memory file.
 * - **Located** - exactly one of `MEMORY_LOCATION_SCOPES`, which pins the entry
 *   to one project, one thread, one routine, or one assistant task.
 *
 * Both sides must agree on what a set means, so every rule lives here instead of
 * being re-derived in the engine and the panel.
 */

export const MEMORY_AUDIENCES: readonly MemoryAudience[] = ['projects', 'chat', 'assistant']

export const MEMORY_LOCATION_SCOPES = ['project', 'thread', 'routine', 'task'] as const

export type MemoryLocationScope = (typeof MEMORY_LOCATION_SCOPES)[number]

/** The location an entry belongs to: its file, plus the routine it targets. */
export interface MemoryScopeLocation {
  projectId?: string
  threadId?: string
  routineId?: string
}

/** What a memory is being loaded for. */
export interface MemoryContext extends MemoryScopeLocation {
  audience: MemoryAudience
  /** Harness-scoped model key, when the turn runs on a known model. */
  modelKey?: string
}

export function isMemoryAudience(scope: MemoryScope): scope is MemoryAudience {
  return (MEMORY_AUDIENCES as readonly string[]).includes(scope)
}

export function isMemoryLocationScope(scope: MemoryScope): scope is MemoryLocationScope {
  return (MEMORY_LOCATION_SCOPES as readonly string[]).includes(scope)
}

/** The single place an entry is pinned to, or null when it is audience-level. */
export function locationScopeOf(scopes: readonly MemoryScope[]): MemoryLocationScope | null {
  return scopes.find(isMemoryLocationScope) ?? null
}

/**
 * The audience a container id addresses: the inbox holds chats, the assistant
 * container holds assistant tasks, and everything else is a project.
 */
export function memoryAudienceForContainer(projectId?: string): MemoryAudience {
  if (projectId === INBOX_PROJECT_ID) return 'chat'
  if (projectId === ASSISTANT_SPACE_ID) return 'assistant'
  return 'projects'
}

/**
 * Whether a scope set applies to one context, ignoring the model-key gate.
 *
 * An empty set applies to every audience. A located entry applies only inside
 * the place it names, which is also what keeps a routine's memory out of every
 * other routine's tasks.
 *
 * `thread` covers a conversation in either conversational audience (a project
 * thread and a chat thread are the same idea), while `task` is the assistant's
 * own thread level.
 */
export function memoryScopesMatchContext(
  entry: Pick<MemoryEntry, 'scopes' | 'projectId' | 'threadId' | 'routineId'>,
  context: MemoryContext
): boolean {
  const scopes = entry.scopes
  const location = locationScopeOf(scopes)
  if (!location) {
    if (scopes.length === 0) return true
    return scopes.some((scope) => scope === context.audience)
  }
  switch (location) {
    case 'project':
      return context.audience === 'projects' && entry.projectId === context.projectId
    case 'thread':
      return (
        (context.audience === 'projects' || context.audience === 'chat') &&
        entry.projectId === context.projectId &&
        entry.threadId === context.threadId
      )
    case 'routine':
      return (
        context.audience === 'assistant' &&
        Boolean(context.routineId) &&
        entry.routineId === context.routineId
      )
    case 'task':
      return context.audience === 'assistant' && entry.threadId === context.threadId
  }
}

/**
 * Whether an entry is sent to the agent for one context. Model memories stay
 * gated on the active model key, exactly as they were.
 */
export function memoryAppliesToContext(entry: MemoryEntry, context: MemoryContext): boolean {
  if (entry.category === 'models') {
    if (!context.modelKey || !entry.modelKeys?.includes(context.modelKey)) return false
  }
  return memoryScopesMatchContext(entry, context)
}

/**
 * The ids an entry must carry for a scope set, which is also the file it lives
 * in (the routine id only filters inside the assistant container's own file).
 *
 * `context` supplies the panel's own project/thread/routine for a staged entry
 * that has not chosen one yet.
 */
export function memoryLocationForScopes(
  scopes: readonly MemoryScope[],
  context: MemoryScopeLocation = {}
): MemoryScopeLocation {
  const location = locationScopeOf(scopes)
  if (!location) {
    if (scopes.length === 1 && scopes[0] === 'chat') return { projectId: INBOX_PROJECT_ID }
    if (scopes.length === 1 && scopes[0] === 'assistant') {
      return { projectId: ASSISTANT_SPACE_ID }
    }
    return {}
  }
  switch (location) {
    case 'project': {
      if (!context.projectId) throw new Error('This memory needs a project to live in.')
      return { projectId: context.projectId }
    }
    case 'thread': {
      if (!context.projectId || !context.threadId) {
        throw new Error('This memory needs a project and a thread to live in.')
      }
      return { projectId: context.projectId, threadId: context.threadId }
    }
    case 'routine': {
      if (!context.routineId) throw new Error('This memory needs a routine to live in.')
      return { projectId: ASSISTANT_SPACE_ID, routineId: context.routineId }
    }
    case 'task': {
      if (!context.threadId) throw new Error('This memory needs a task to live in.')
      return { projectId: ASSISTANT_SPACE_ID, threadId: context.threadId }
    }
  }
}

/** Canonical order, so a stored scope set never depends on click order. */
export function orderMemoryScopes(scopes: readonly MemoryScope[]): MemoryScope[] {
  const ordered: MemoryScope[] = []
  for (const audience of MEMORY_AUDIENCES) {
    if (scopes.includes(audience)) ordered.push(audience)
  }
  for (const location of MEMORY_LOCATION_SCOPES) {
    if (scopes.includes(location)) ordered.push(location)
  }
  return ordered
}

/**
 * Read a scope set from stored metadata, accepting both the current `scopes`
 * list and the single `scope` value older files wrote.
 *
 * The retired `global` value meant "projects and chats", so it parses to
 * exactly that instead of widening to every audience. `project`/`thread` pinned
 * to the assistant container are the assistant's own levels, which the assistant
 * model calls `assistant` and `task`.
 */
export function readMemoryScopes(input: {
  scopes?: readonly string[]
  scope?: string
  projectId?: string
}): MemoryScope[] {
  const known = new Set<string>([...MEMORY_AUDIENCES, ...MEMORY_LOCATION_SCOPES])
  if (input.scopes) {
    const valid = input.scopes.filter((scope): scope is MemoryScope => known.has(scope))
    return orderMemoryScopes(valid)
  }
  const legacy = input.scope
  if (!legacy) return []
  if (legacy === 'global') return ['projects', 'chat']
  if (legacy === 'project') {
    return input.projectId === ASSISTANT_SPACE_ID ? ['assistant'] : ['project']
  }
  if (legacy === 'thread') {
    return input.projectId === ASSISTANT_SPACE_ID ? ['task'] : ['thread']
  }
  return known.has(legacy) ? [legacy as MemoryScope] : []
}

/** The scope vocabulary each audience can propose, used by extraction and its submission guard. */
export const MEMORY_AUDIENCE_SCOPES: Record<MemoryAudience, readonly MemoryScope[]> = {
  projects: ['projects', 'project', 'thread'],
  chat: ['chat', 'thread'],
  assistant: ['assistant', 'routine', 'task']
}

/** A stable key for a scope set, so two equal sets always compare equal. */
export function memoryScopeKey(scopes: readonly MemoryScope[]): string {
  return orderMemoryScopes(scopes).join(',')
}

/** The stored metadata value for a scope set (`all` when it applies everywhere). */
export function writeMemoryScopes(scopes: readonly MemoryScope[]): string {
  return scopes.length === 0 ? 'all' : orderMemoryScopes(scopes).join(',')
}

/** A short human summary of a scope set, for logs and proposal rows. */
export function memoryScopeSummary(scopes: readonly MemoryScope[]): string {
  if (scopes.length === 0) return 'All audiences'
  const location = locationScopeOf(scopes)
  if (location) {
    switch (location) {
      case 'project':
        return 'Specific project'
      case 'thread':
        return 'Thread'
      case 'routine':
        return 'Routine'
      case 'task':
        return 'Task'
    }
  }
  return scopes
    .map((scope) => (scope === 'projects' ? 'Projects' : scope === 'chat' ? 'Chats' : 'Assistants'))
    .join(' + ')
}
