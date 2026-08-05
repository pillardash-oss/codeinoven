import { generateId } from '../utils'
import type { HistoryEntry, HistoryRole } from '../types'
import type { Database } from '../../main/database/database'
import { HistoryRepo } from '../../main/database/repositories/history-repo'

export class HistoryEngine {
  private repo: HistoryRepo

  constructor(db: Database) {
    this.repo = new HistoryRepo(db)
  }

  async append(
    projectId: string,
    threadId: string,
    role: HistoryRole,
    content: string,
    metadata?: HistoryEntry['metadata']
  ): Promise<HistoryEntry> {
    const sequence = this.repo.maxSequence(threadId) + 1
    const entry: HistoryEntry = {
      id: generateId(),
      role,
      content,
      metadata,
      timestamp: Date.now()
    }
    this.repo.insert(entry.id, threadId, role, content, metadata, sequence, entry.timestamp)
    return entry
  }

  async load(projectId: string, threadId: string, limit?: number): Promise<HistoryEntry[]> {
    return this.repo.load(threadId, limit)
  }

  async count(projectId: string, threadId: string): Promise<number> {
    return this.repo.count(threadId)
  }

  truncate(projectId: string, threadId: string, sequence: number): void {
    this.repo.truncateFromSequence(threadId, sequence)
  }

  search(query: string, projectId?: string, limit = 20): HistoryEntry[] {
    return this.repo.search(query, projectId, limit)
  }
}
