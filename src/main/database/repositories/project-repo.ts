import type { Database } from '../database'
import type { Project } from '../../../lib/types'

interface ProjectRow {
  id: string
  name: string
  path: string
  source: string
  host: string | null
  provider_id: string
  workflow_id: string
  thread_limit: number
  hidden: number
  pinned: number
  sort_order: number | null
  icon: string | null
  color: string | null
  icon_type: string | null
  change_tracking_mode: string
  has_deployments: number
  created_at: number
  updated_at: number
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    source: row.source as 'local' | 'ssh',
    host: row.host ?? undefined,
    providerId: row.provider_id,
    workflowId: row.workflow_id,
    threadLimit: row.thread_limit,
    hidden: row.hidden === 1 || undefined,
    pinned: row.pinned === 1 || undefined,
    sortOrder: row.sort_order ?? undefined,
    icon: row.icon ?? undefined,
    color: row.color ?? undefined,
    iconType: row.icon_type ?? undefined,
    changeTrackingMode: row.change_tracking_mode as 'git' | 'manual',
    hasDeployments: row.has_deployments === 1 || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export class ProjectRepo {
  constructor(private db: Database) {}

  upsert(project: Project): void {
    this.db.run(
      `INSERT INTO projects(
        id, name, path, source, host, provider_id, workflow_id, thread_limit,
        hidden, pinned, sort_order, icon, color, icon_type, change_tracking_mode,
        has_deployments, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        source = excluded.source,
        host = excluded.host,
        provider_id = excluded.provider_id,
        workflow_id = excluded.workflow_id,
        thread_limit = excluded.thread_limit,
        hidden = excluded.hidden,
        pinned = excluded.pinned,
        sort_order = excluded.sort_order,
        icon = excluded.icon,
        color = excluded.color,
        icon_type = excluded.icon_type,
        change_tracking_mode = excluded.change_tracking_mode,
        has_deployments = excluded.has_deployments,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at`,
      project.id,
      project.name,
      project.path,
      project.source,
      project.host ?? null,
      project.providerId,
      project.workflowId,
      project.threadLimit,
      project.hidden ? 1 : 0,
      project.pinned ? 1 : 0,
      project.sortOrder ?? null,
      project.icon ?? null,
      project.color ?? null,
      project.iconType ?? null,
      project.changeTrackingMode ?? 'manual',
      project.hasDeployments ? 1 : 0,
      project.createdAt,
      project.updatedAt
    )
  }

  get(id: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
    return row ? rowToProject(row) : null
  }

  /** Read one project on the database worker so interaction paths never touch SQLite on main. */
  async getViaWorker(id: string): Promise<Project | null> {
    const result = await this.db.queryViaWorker('SELECT * FROM projects WHERE id = ?', [id], 1)
    if (!result.ok) return null
    const row = (result.rows as unknown as ProjectRow[])[0]
    return row ? rowToProject(row) : null
  }

  list(): Project[] {
    const rows = this.db.all<ProjectRow>(
      'SELECT * FROM projects ORDER BY sort_order ASC, updated_at DESC'
    )
    return rows.map(rowToProject)
  }

  delete(id: string): void {
    this.db.run('DELETE FROM projects WHERE id = ?', id)
  }

  search(query: string, limit = 20): Project[] {
    const rows = this.db.all<ProjectRow>(
      `SELECT p.* FROM projects p
       JOIN project_fts fts ON p.rowid = fts.rowid
       WHERE project_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
      query,
      limit
    )
    return rows.map(rowToProject)
  }

  findByPath(path: string): Project | null {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE path = ?', path)
    return row ? rowToProject(row) : null
  }

  listPinned(): Project[] {
    const rows = this.db.all<ProjectRow>(
      'SELECT * FROM projects WHERE pinned = 1 ORDER BY sort_order ASC'
    )
    return rows.map(rowToProject)
  }

  setPinned(id: string, pinned: boolean): void {
    this.db.run(
      'UPDATE projects SET pinned = ?, updated_at = ? WHERE id = ?',
      pinned ? 1 : 0,
      Date.now(),
      id
    )
  }

  setSortOrder(id: string, sortOrder: number): void {
    this.db.run(
      'UPDATE projects SET sort_order = ?, updated_at = ? WHERE id = ?',
      sortOrder,
      Date.now(),
      id
    )
  }
}
