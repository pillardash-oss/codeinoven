import type { AuthoredWorkKind, WorkGroupState } from '../../lib/ipc/design'
import { WorkGroupRepo } from '../database/repositories/work-group-repo'
import type { Database } from '../database/database'

/**
 * The board's groups, as the agent reads and arranges them.
 *
 * Grouping is the user's organisation of their own designs: a group is a record
 * about a folder, never a place to put it. That makes two things true at once,
 * and both are why this module exists rather than the agent editing anything:
 *
 *   - the arrangement is worth the agent knowing, because "put the pricing
 *     experiments together" is a design request in the user's words, and an agent
 *     that cannot see the board will answer it by renaming folders;
 *   - the arrangement must never move work. The only folder this module can touch
 *     is none: a name, a fold and a membership are all it writes.
 *
 * The same read feeds the session briefing, so every turn of a design session
 * carries the current arrangement and the moment it was last changed. That is how
 * an agent notices the user regrouped things between two messages without being
 * told.
 */

/** The folder part of a project-relative design path, for a label. */
function designName(directory: string): string {
  return directory.split('/').at(-1) ?? directory
}

/**
 * What the design capability's `groups` operation answers, in the agent's terms.
 *
 * Groups carry their designs by name rather than only by path, because that is how
 * the user talks about them; the folder travels beside it because that is what an
 * agent needs to open or edit one.
 */
export interface DesignGroupReport {
  /** Groups in board order, each with the designs it holds. */
  groups: Array<{
    id: string
    name: string
    collapsed: boolean
    designs: Array<{ name: string; directory: string }>
  }>
  /** How the board draws them, which the agent may change. */
  view: string
  /** When the user last arranged the board (ms). */
  updatedAt: number
  /** What the last operation did, so a reply can say it plainly. */
  note?: string
}

function stripView(directory: string): string {
  return directory.replace(/^\.\//u, '')
}

/**
 * Resolve a group the agent named, by id or by name.
 *
 * The agent reads names, so names are what it will pass back; the id is accepted
 * because that is what a report hands it. A name is matched case-insensitively,
 * exactly as the board enforces uniqueness, so there is never a second candidate.
 */
function resolveGroup(state: WorkGroupState, reference: string): { id: string; name: string } {
  const wanted = reference.trim()
  if (wanted === '') throw new TypeError('Name a group to change')
  const byId = state.groups.find((group) => group.id === wanted)
  if (byId) return { id: byId.id, name: byId.name }
  const byName = state.groups.find(
    (group) => group.name.toLocaleLowerCase() === wanted.toLocaleLowerCase()
  )
  if (!byName)
    throw new TypeError(
      `There is no group named "${wanted}". The board holds: ${
        state.groups.map((group) => group.name).join(', ') || 'no groups yet'
      }.`
    )
  return { id: byName.id, name: byName.name }
}

/** The board as a report: every group with its designs, then what is ungrouped. */
function report(state: WorkGroupState, note?: string): DesignGroupReport {
  return {
    groups: state.groups.map((group) => ({
      id: group.id,
      name: group.name,
      collapsed: group.collapsed,
      designs: state.members
        .filter((member) => member.groupId === group.id)
        .toSorted((left, right) => left.position - right.position)
        .map((member) => ({
          name: designName(member.directory),
          directory: stripView(member.directory)
        }))
    })),
    view: state.view,
    updatedAt: state.updatedAt,
    ...(note === undefined ? {} : { note })
  }
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`"${key}" is required and cannot be empty`)
  return value.trim()
}

function optionalString(input: Record<string, unknown>, key: string): string | null {
  const value = input[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * Folders the agent named, refused when they cannot be a project-relative path.
 *
 * The refusal is deliberately about shape and never about existence: an agent may
 * legitimately group a design it has just written, and the board reads the folder
 * list from disk on its own. What must never reach the database is a path that
 * reaches outside the project.
 */
function requireDesigns(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(`"${key}" must list at least one design folder`)
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '')
      throw new TypeError('A design folder must be a project-relative path')
    const directory = stripView(entry.trim())
    if (directory.startsWith('/') || directory.split('/').includes('..') || /^[a-zA-Z]:/u.test(directory))
      throw new TypeError(`"${entry}" is not a project-relative folder`)
    return directory
  })
}

/**
 * Run one arrangement operation for the design capability.
 *
 * Every operation answers with the whole board afterwards, so an agent that
 * arranges three groups reads the result of its own work instead of asking again,
 * and so a wrong guess at a group name is answered with the names that do exist.
 */
export async function executeDesignGroupOperation(
  database: Database,
  context: { projectId: string },
  operation: string,
  input: Record<string, unknown>,
  announce?: (projectId: string, kind: AuthoredWorkKind, updatedAt: number) => void
): Promise<unknown> {
  const repository = new WorkGroupRepo(database)
  const kind: AuthoredWorkKind =
    input['kind'] === 'video' ? 'video' : input['kind'] === 'design' ? 'design' : 'design'
  const before = repository.state(context.projectId, kind)

  if (operation === 'groups') return report(before)

  if (operation !== 'organize-designs') {
    throw new Error(
      `The design group service handles the groups and organize-designs operations, and no operation named "${operation}".`
    )
  }

  /** Answer with the new board, and tell the open boards it moved: an agent's
   *  change and the user's own drop have to reach every window the same way. */
  const done = (state: WorkGroupState, note: string): DesignGroupReport => {
    announce?.(context.projectId, kind, state.updatedAt)
    return report(state, note)
  }

  const action = requireString(input, 'action')
  if (action === 'create') {
    const name = requireString(input, 'name')
    return done(repository.create(context.projectId, kind, name), `Created the group "${name}".`)
  }
  if (action === 'rename') {
    const group = resolveGroup(before, requireString(input, 'group'))
    const name = requireString(input, 'name')
    return done(
      repository.rename(context.projectId, group.id, name),
      `Renamed "${group.name}" to "${name}".`
    )
  }
  if (action === 'delete') {
    const group = resolveGroup(before, requireString(input, 'group'))
    return done(
      repository.remove(context.projectId, group.id),
      `Deleted the group "${group.name}". Its designs are ungrouped; no folder was touched.`
    )
  }
  if (action === 'assign') {
    const designs = requireDesigns(input, 'designs')
    // A null group is the ungrouped part of the board, which is where a design
    // goes when the user wants it out of every group without losing it.
    const named = optionalString(input, 'group')
    const group = named === null ? null : resolveGroup(before, named)
    const state = repository.move(
      context.projectId,
      kind,
      designs.map((directory) => ({ directory, groupId: group?.id ?? null }))
    )
    return done(
      state,
      group === null
        ? `Ungrouped ${designs.length === 1 ? '1 design' : `${designs.length} designs`}. No folder moved.`
        : `Moved ${designs.length === 1 ? '1 design' : `${designs.length} designs`} into "${group.name}". No folder moved.`
    )
  }
  if (action === 'reorder') {
    const order = input['order']
    if (!Array.isArray(order) || order.length === 0)
      throw new TypeError('"order" must list the groups in the order you want')
    const ids = order.map((entry) => {
      if (typeof entry !== 'string') throw new TypeError('"order" must list group names')
      return resolveGroup(before, entry).id
    })
    return done(
      repository.reorder(context.projectId, kind, ids),
      'Reordered the groups on the board.'
    )
  }
  if (action === 'view') {
    const view = input['view']
    if (view !== 'cards' && view !== 'list')
      throw new TypeError('"view" must be "cards" or "list"')
    return done(
      repository.setView(context.projectId, kind, view),
      `The board now shows designs as ${view === 'cards' ? 'pictures' : 'a folded list'}.`
    )
  }
  throw new TypeError(`"${action}" is not an arrangement action this capability offers`)
}

/**
 * The board's arrangement as a paragraph for a design session's own contract.
 *
 * Empty when the user has not grouped anything, because a session that has to read
 * "no groups yet" every turn is paying for a feature nobody used. When there are
 * groups it states them, stamps when they last moved, and says the one rule that
 * keeps an agent from turning an arrangement into a rename.
 */
export function designGroupBriefing(database: Database, projectId: string): string {
  const state = new WorkGroupRepo(database).state(projectId, 'design')
  if (state.groups.length === 0) return ''
  const lines = state.groups.map((group) => {
    const held = state.members
      .filter((member) => member.groupId === group.id)
      .toSorted((left, right) => left.position - right.position)
      .map((member) => designName(member.directory))
    return `- "${group.name}": ${held.length === 0 ? 'empty' : held.join(', ')}${group.collapsed ? ' (folded on the board)' : ''}`
  })
  const changed =
    state.updatedAt > 0
      ? `The user last rearranged it ${new Date(state.updatedAt).toISOString()}.`
      : ''
  return `The user organises this project's designs on the coordinator board in groups. They are records about folders, not folders themselves, and the board draws them either as pictures of the designs or as a folded list.

${lines.join('\n')}

${changed} Read them with this capability's \`groups\` operation before you speak about the arrangement, and change it with \`organize-designs\` when the user asks you to group, rename, fold or ungroup their designs. Never rename or move a folder to match a group, and never treat a group as a save path: every design still lives in \`<root>/<name>/\`.`
}
