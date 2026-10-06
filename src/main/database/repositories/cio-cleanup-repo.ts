import type { CioCleanupExclusion } from '../../../lib/types/cio-cleanup'
import type { Database } from '../database'

interface ExclusionRow {
  project_id: string
  scope_bucket_id: string
  thread_id: string
  path: string
  created_at: number
}

function rowToExclusion(row: ExclusionRow): CioCleanupExclusion {
  return {
    projectId: row.project_id,
    scopeBucketId: row.scope_bucket_id,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    path: row.path,
    createdAt: row.created_at
  }
}

/**
 * Paths the user protected from CIO Cleanup.
 *
 * A row names one path inside a workspace's `.cio` folder and covers everything
 * beneath it. The mount triple is stored instead of an absolute path so an
 * exclusion survives a project that moves and a managed worktree scope that is
 * removed and recreated under the same name.
 *
 * Every read is worker-backed: the sweeper, the settings page and the file
 * tree's context menu all ask for the list while the app is interactive.
 */
export class CioCleanupRepo {
  constructor(private db: Database) {}

  /** Read the exclusion list on the database worker so no interaction path blocks main. */
  async listViaWorker(): Promise<CioCleanupExclusion[]> {
    const result = await this.db.queryViaWorker(
      'SELECT * FROM cio_cleanup_exclusions ORDER BY project_id, scope_bucket_id, thread_id, path',
      [],
      0
    )
    if (!result.ok) return []
    return (result.rows as unknown as ExclusionRow[]).map(rowToExclusion)
  }

  /** Protect one path. Re-adding an existing path refreshes its timestamp, never duplicates it. */
  add(exclusion: CioCleanupExclusion): void {
    this.db.run(
      `INSERT INTO cio_cleanup_exclusions(project_id, scope_bucket_id, thread_id, path, created_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(project_id, scope_bucket_id, thread_id, path) DO UPDATE SET
         created_at = excluded.created_at`,
      exclusion.projectId,
      exclusion.scopeBucketId,
      exclusion.threadId ?? '',
      exclusion.path,
      exclusion.createdAt
    )
  }

  /** Stop protecting one exact path. */
  remove(
    exclusion: Pick<CioCleanupExclusion, 'projectId' | 'scopeBucketId' | 'path'> & {
      threadId?: string
    }
  ): void {
    this.db.run(
      'DELETE FROM cio_cleanup_exclusions WHERE project_id=? AND scope_bucket_id=? AND thread_id=? AND path=?',
      exclusion.projectId,
      exclusion.scopeBucketId,
      exclusion.threadId ?? '',
      exclusion.path
    )
  }

  /** Drop the exclusions of a project that is no longer registered. */
  removeForProject(projectId: string): void {
    this.db.run('DELETE FROM cio_cleanup_exclusions WHERE project_id=?', projectId)
  }
}
