import { uuidv7 } from '../../../lib/id'
import type {
  AuthoredWorkKind,
  WorkGroup,
  WorkGroupMember,
  WorkGroupMove,
  WorkGroupState,
  WorkGroupView
} from '../../../lib/ipc/design'
import type { Database } from '../database'

/**
 * The board's own organisation of a project's authored work.
 *
 * Grouping is a reading of the work, not a place to put it: every design stays
 * exactly where the agent wrote it, and this table only says which group the
 * board draws it under. That distinction is what makes the feature safe to use
 * freely, so it is enforced here rather than left to the callers: nothing in this
 * repository ever touches a folder, and a removed group is a removed group rather
 * than a moved design.
 *
 * A design with no membership row is ungrouped. The absence of a record is what
 * "not in a group" means, so a project that never used groups costs nothing and a
 * design added by the agent appears on the board the moment its folder exists.
 */

interface WorkGroupRow {
  id: string
  kind: string
  name: string
  position: number
  collapsed: number
  created_at: number
  updated_at: number
}

interface WorkGroupMemberRow {
  directory: string
  group_id: string
  position: number
  updated_at: number
}

interface WorkGroupBoardRow {
  view: string
  updated_at: number
}

/** Longest group name the board accepts, so one name cannot fill the panel. */
const MAX_GROUP_NAME = 80

/** Longest folder path a membership row may name. Matches the board's own paths. */
const MAX_DIRECTORY = 1024

function kindOf(value: string): AuthoredWorkKind {
  return value === 'video' ? 'video' : 'design'
}

function viewOf(value: string): WorkGroupView {
  return value === 'list' ? 'list' : 'cards'
}

function toGroup(row: WorkGroupRow): WorkGroup {
  return {
    id: row.id,
    kind: kindOf(row.kind),
    name: row.name,
    position: row.position,
    collapsed: row.collapsed === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toMember(row: WorkGroupMemberRow): WorkGroupMember {
  return { directory: row.directory, groupId: row.group_id, position: row.position }
}

/**
 * A group name as the board stores it, or a rejection the user can act on.
 *
 * Trimmed because a name the user cannot see the edges of is a name they cannot
 * search for, and NUL-free because it is stored beside folders in the same rows.
 */
function requireGroupName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Group name is required')
  const name = value.trim()
  if (name === '') throw new TypeError('Group name cannot be empty')
  if (name.length > MAX_GROUP_NAME)
    throw new TypeError(`Group name cannot be longer than ${MAX_GROUP_NAME} characters`)
  if (name.includes('\u0000')) throw new TypeError('Group name is invalid')
  return name
}

/** A project-relative folder as the board spells it. */
function requireDirectory(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('Design folder is required')
  if (value.length > MAX_DIRECTORY || value.includes('\u0000'))
    throw new TypeError('Design folder is invalid')
  return value
}

function requireView(value: unknown): WorkGroupView {
  if (value !== 'cards' && value !== 'list') throw new TypeError('Board view is invalid')
  return value
}

export class WorkGroupRepo {
  constructor(private readonly db: Database) {}

  /**
   * Everything the board draws, in one read: the groups in order, the membership
   * of every grouped design, the view, and the stamp of the last change.
   *
   * One query per part rather than a join, because the three are different shapes
   * and a join would repeat the boards row for every design in a project.
   */
  state(projectId: string, kind: AuthoredWorkKind): WorkGroupState {
    const groups = this.db
      .all<WorkGroupRow>(
        'SELECT id, kind, name, position, collapsed, created_at, updated_at FROM work_groups WHERE project_id = ? AND kind = ? ORDER BY position, created_at',
        projectId,
        kind
      )
      .map(toGroup)
    const memberRows = this.db.all<WorkGroupMemberRow>(
      'SELECT directory, group_id, position, updated_at FROM work_group_members WHERE project_id = ? AND kind = ? ORDER BY position',
      projectId,
      kind
    )
    const board = this.db.get<WorkGroupBoardRow>(
      'SELECT view, updated_at FROM work_group_boards WHERE project_id = ? AND kind = ?',
      projectId,
      kind
    )
    const stamps = [
      board?.updated_at ?? 0,
      ...groups.map((group) => group.updatedAt),
      ...memberRows.map((row) => row.updated_at)
    ]
    return {
      projectId,
      kind,
      groups,
      members: memberRows.map(toMember),
      view: viewOf(board?.view ?? 'cards'),
      updatedAt: Math.max(0, ...stamps)
    }
  }

  /** Make a group at the end of the board's order. */
  create(projectId: string, kind: AuthoredWorkKind, rawName: string): WorkGroupState {
    const name = requireGroupName(rawName)
    this.refuseDuplicateName(projectId, kind, name, null)
    const now = Date.now()
    const last = this.db.get<{ position: number | null }>(
      'SELECT MAX(position) AS position FROM work_groups WHERE project_id = ? AND kind = ?',
      projectId,
      kind
    )
    this.db.transaction(() => {
      this.db.run(
        'INSERT INTO work_groups (id, project_id, kind, name, position, collapsed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
        uuidv7(),
        projectId,
        kind,
        name,
        (last?.position ?? -1) + 1,
        now,
        now
      )
      this.stampBoard(projectId, kind, now)
    })
    return this.state(projectId, kind)
  }

  /** Rename a group. Designs keep their membership, because the id is unchanged. */
  rename(projectId: string, groupId: string, rawName: string): WorkGroupState {
    const name = requireGroupName(rawName)
    const group = this.requireGroup(projectId, groupId)
    this.refuseDuplicateName(projectId, group.kind, name, groupId)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.run(
        'UPDATE work_groups SET name = ?, updated_at = ? WHERE id = ?',
        name,
        now,
        groupId
      )
      this.stampBoard(projectId, group.kind, now)
    })
    return this.state(projectId, group.kind)
  }

  /**
   * Delete a group and nothing else.
   *
   * Its designs become ungrouped, which is the state a design the agent has just
   * written is in anyway. Deleting an organisation the user made must never be a
   * way to lose the work it described.
   */
  remove(projectId: string, groupId: string): WorkGroupState {
    const group = this.requireGroup(projectId, groupId)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.run('DELETE FROM work_group_members WHERE group_id = ?', groupId)
      this.db.run('DELETE FROM work_groups WHERE id = ?', groupId)
      this.reindexGroups(projectId, group.kind)
      this.stampBoard(projectId, group.kind, now)
    })
    return this.state(projectId, group.kind)
  }

  /** Fold or unfold a group, which is a persisted part of the arrangement. */
  setCollapsed(projectId: string, groupId: string, collapsed: boolean): WorkGroupState {
    const group = this.requireGroup(projectId, groupId)
    const now = Date.now()
    this.db.transaction(() => {
      this.db.run(
        'UPDATE work_groups SET collapsed = ?, updated_at = ? WHERE id = ?',
        collapsed ? 1 : 0,
        now,
        groupId
      )
      this.stampBoard(projectId, group.kind, now)
    })
    return this.state(projectId, group.kind)
  }

  /** Put the groups in the order the user dragged them into. */
  reorder(projectId: string, kind: AuthoredWorkKind, ids: string[]): WorkGroupState {
    const existing = this.db.all<{ id: string }>(
      'SELECT id FROM work_groups WHERE project_id = ? AND kind = ? ORDER BY position, created_at',
      projectId,
      kind
    )
    const known = new Set(existing.map((row) => row.id))
    // An id the project does not hold is a stale board, not a reason to reorder
    // the wrong groups: the order applied is the caller's list followed by
    // everything it did not name, so nothing is ever dropped by a reorder.
    const order = [
      ...ids.filter((id) => known.has(id)),
      ...existing.map((row) => row.id).filter((id) => !ids.includes(id))
    ]
    const now = Date.now()
    this.db.transaction(() => {
      order.forEach((id, index) => {
        this.db.run(
          'UPDATE work_groups SET position = ?, updated_at = ? WHERE id = ? AND project_id = ?',
          index,
          now,
          id,
          projectId
        )
      })
      this.stampBoard(projectId, kind, now)
    })
    return this.state(projectId, kind)
  }

  /**
   * Move designs into a group, out of one, or to another place inside the one
   * they are already in.
   *
   * The whole set is applied as one arrangement: every group the moves touch is
   * renumbered from its own order with the dropped designs spliced in where the
   * caller asked, so a drag between two groups leaves both lists contiguous and
   * the next drop lands where the user expects it.
   */
  move(projectId: string, kind: AuthoredWorkKind, moves: WorkGroupMove[]): WorkGroupState {
    if (moves.length === 0) return this.state(projectId, kind)
    const groups = new Set(
      this.db
        .all<{ id: string }>(
          'SELECT id FROM work_groups WHERE project_id = ? AND kind = ?',
          projectId,
          kind
        )
        .map((row) => row.id)
    )
    // Every group's current order, so a drop is a splice into a list the user is
    // looking at rather than an append onto whatever the rows happen to be.
    const order = new Map<string, string[]>()
    for (const row of this.db.all<WorkGroupMemberRow>(
      'SELECT directory, group_id, position, updated_at FROM work_group_members WHERE project_id = ? AND kind = ? ORDER BY position',
      projectId,
      kind
    )) {
      const list = order.get(row.group_id) ?? []
      list.push(row.directory)
      order.set(row.group_id, list)
    }
    for (const move of moves) {
      const directory = requireDirectory(move.directory)
      const target = move.groupId === null ? null : move.groupId
      if (target !== null && !groups.has(target))
        throw new TypeError('That group no longer exists on this board')
      for (const list of order.values()) {
        const index = list.indexOf(directory)
        if (index !== -1) list.splice(index, 1)
      }
      if (target === null) continue
      const list = order.get(target) ?? []
      const requested = typeof move.position === 'number' ? Math.trunc(move.position) : list.length
      list.splice(Math.max(0, Math.min(requested, list.length)), 0, directory)
      order.set(target, list)
    }
    const now = Date.now()
    this.db.transaction(() => {
      this.db.run(
        'DELETE FROM work_group_members WHERE project_id = ? AND kind = ?',
        projectId,
        kind
      )
      for (const [groupId, list] of order) {
        list.forEach((directory, position) => {
          this.db.run(
            'INSERT INTO work_group_members (project_id, kind, directory, group_id, position, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            projectId,
            kind,
            directory,
            groupId,
            position,
            now
          )
        })
      }
      this.stampBoard(projectId, kind, now)
    })
    return this.state(projectId, kind)
  }

  /** Remember how the board draws the work: pictures, or the folded list. */
  setView(projectId: string, kind: AuthoredWorkKind, view: WorkGroupView): WorkGroupState {
    const now = Date.now()
    this.db.run(
      `INSERT INTO work_group_boards (project_id, kind, view, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, kind) DO UPDATE SET view = excluded.view, updated_at = excluded.updated_at`,
      projectId,
      kind,
      requireView(view),
      now
    )
    return this.state(projectId, kind)
  }

  /**
   * Follow a design whose folder was renamed or moved.
   *
   * Renaming a design is a real move on disk and the membership is keyed by the
   * folder, so without this the design would silently fall out of its group at
   * exactly the moment the user renamed it. Children are rewritten too, because a
   * folder that moves takes its pages with it.
   */
  relocate(input: { projectId: string; kind: AuthoredWorkKind; from: string; to: string }): void {
    if (input.from === input.to) return
    const escaped = input.from.replace(/[%_\\]/gu, '\\$&')
    this.db.run(
      `UPDATE work_group_members
          SET directory = ? || substr(directory, ?), updated_at = ?
        WHERE project_id = ? AND kind = ? AND (directory = ? OR directory LIKE ? ESCAPE '\\')`,
      input.to,
      input.from.length + 1,
      Date.now(),
      input.projectId,
      input.kind,
      input.from,
      `${escaped}/%`
    )
  }

  /** Drop a removed project's organisation, so no board outlives its project. */
  deleteProject(projectId: string): void {
    this.db.run('DELETE FROM work_group_members WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM work_groups WHERE project_id = ?', projectId)
    this.db.run('DELETE FROM work_group_boards WHERE project_id = ?', projectId)
  }

  private requireGroup(projectId: string, groupId: string): WorkGroup {
    if (typeof groupId !== 'string' || groupId === '')
      throw new TypeError('A group id is required')
    const row = this.db.get<WorkGroupRow>(
      'SELECT id, kind, name, position, collapsed, created_at, updated_at FROM work_groups WHERE id = ? AND project_id = ?',
      groupId,
      projectId
    )
    if (!row) throw new TypeError('That group no longer exists on this board')
    return toGroup(row)
  }

  /** Names are unique per board, so two groups can never look like one. */
  private refuseDuplicateName(
    projectId: string,
    kind: AuthoredWorkKind,
    name: string,
    exceptId: string | null
  ): void {
    const clash = this.db.get<{ id: string }>(
      'SELECT id FROM work_groups WHERE project_id = ? AND kind = ? AND name = ? COLLATE NOCASE AND id IS NOT ?',
      projectId,
      kind,
      name,
      exceptId
    )
    if (clash) throw new TypeError(`A group named "${name}" already exists`)
  }

  /** Renumber a board's groups so a deletion leaves no gap in the order. */
  private reindexGroups(projectId: string, kind: AuthoredWorkKind): void {
    const rows = this.db.all<{ id: string }>(
      'SELECT id FROM work_groups WHERE project_id = ? AND kind = ? ORDER BY position, created_at',
      projectId,
      kind
    )
    rows.forEach((row, index) => {
      this.db.run(
        'UPDATE work_groups SET position = ? WHERE id = ? AND project_id = ?',
        index,
        row.id,
        projectId
      )
    })
  }

  /**
   * Advance the board's change stamp, creating its row when it has none.
   *
   * Every arrangement change goes through here, which is what makes the stamp an
   * honest answer to "has the user rearranged anything since I looked": the view,
   * a group, and a membership all move it.
   */
  private stampBoard(projectId: string, kind: AuthoredWorkKind, at: number): void {
    this.db.run(
      `INSERT INTO work_group_boards (project_id, kind, view, updated_at)
       VALUES (?, ?, 'cards', ?)
       ON CONFLICT(project_id, kind) DO UPDATE SET updated_at = excluded.updated_at`,
      projectId,
      kind,
      at
    )
  }
}
