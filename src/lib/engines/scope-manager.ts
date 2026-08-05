import type { Database } from '../../main/database/database'
import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBoard } from '../types'

const SCOPE_BOARD_VERSION = 1

function defaultBoard(): ScopeBoard {
  return {
    version: SCOPE_BOARD_VERSION,
    buckets: [
      {
        id: DEFAULT_SCOPE_BUCKET_ID,
        name: 'Default',
        sortOrder: 0,
        collapsed: false,
        collapsedSlices: []
      }
    ]
  }
}

export class ScopeManager {
  constructor(private db: Database) {}

  getBoard(projectId: string): ScopeBoard {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM scope_boards WHERE project_id=?',
      projectId
    )
    if (row) return JSON.parse(row.data) as ScopeBoard

    const created = defaultBoard()
    this.db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      projectId,
      JSON.stringify(created),
      Date.now()
    )
    return created
  }

  saveBoard(projectId: string, board: ScopeBoard): ScopeBoard {
    const defaultBucket = board.buckets.find((bucket) => bucket.id === DEFAULT_SCOPE_BUCKET_ID)
    if (!defaultBucket) {
      throw new Error('The Default scope bucket cannot be removed')
    }

    const saved: ScopeBoard = {
      version: SCOPE_BOARD_VERSION,
      buckets: board.buckets.map((bucket) => ({ ...bucket }))
    }
    this.db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      projectId,
      JSON.stringify(saved),
      Date.now()
    )
    return saved
  }
}
