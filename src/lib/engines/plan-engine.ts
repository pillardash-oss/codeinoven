import { generateId } from '../utils'
import { ensureFeatureSlug, requireLocalProject } from '../project-artifacts'
import type { Database } from '../../main/database/database'
import type { StorageEngine } from '../../main/storage/storage-engine'
import type { Plan, Checklist, ChecklistItem } from '../types'

export class PlanEngine {
  constructor(
    private readonly storage: StorageEngine,
    private readonly db: Database
  ) {}

  async savePlan(projectId: string, threadId: string, content: string): Promise<Plan> {
    const featureSlug = await ensureFeatureSlug(this.db, projectId, threadId)
    const project = requireLocalProject(this.db, projectId)
    await this.storage.writeProjectSpecRaw(projectId, featureSlug, 'plan.md', content, project)

    const plan: Plan = {
      threadId,
      content,
      approved: false,
      createdAt: Date.now()
    }
    this.db.run(
      'INSERT OR REPLACE INTO plans(thread_id, content, approved, created_at) VALUES(?,?,?,?)',
      threadId,
      content,
      0,
      plan.createdAt
    )
    return plan
  }

  getPlan(projectId: string, threadId: string): Plan | null {
    const row = this.db.get<{
      thread_id: string
      content: string
      approved: number
      created_at: number
      approved_at: number | null
    }>('SELECT * FROM plans WHERE thread_id=?', threadId)
    if (!row) return null
    return {
      threadId: row.thread_id,
      content: row.content,
      approved: row.approved === 1,
      createdAt: row.created_at,
      approvedAt: row.approved_at ?? undefined
    }
  }

  async approvePlan(projectId: string, threadId: string): Promise<Plan | null> {
    const plan = this.getPlan(projectId, threadId)
    if (!plan) return null

    const now = Date.now()
    const approved: Plan = { ...plan, approved: true, approvedAt: now }
    this.db.run('UPDATE plans SET approved=1, approved_at=? WHERE thread_id=?', now, threadId)

    const checklist = this.getChecklist(projectId, threadId)
    if (checklist) {
      const frozen = { ...checklist, immutable: true }
      this.db.run(
        'INSERT OR REPLACE INTO checklists(thread_id, data, created_at) VALUES(?,?,?)',
        threadId,
        JSON.stringify(frozen),
        checklist.createdAt
      )
      await this.writeProgress(projectId, threadId, frozen)
    }
    return approved
  }

  async generateChecklist(
    projectId: string,
    threadId: string,
    planContent: string
  ): Promise<Checklist> {
    const items: ChecklistItem[] = planContent
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => ({
        id: generateId(),
        content: line.slice(2).trim(),
        status: 'pending' as const,
        threadId,
        notes: ''
      }))

    const checklist: Checklist = {
      threadId,
      items,
      immutable: false,
      createdAt: Date.now()
    }

    this.db.run(
      'INSERT OR REPLACE INTO checklists(thread_id, data, created_at) VALUES(?,?,?)',
      threadId,
      JSON.stringify(checklist),
      checklist.createdAt
    )
    await this.writeProgress(projectId, threadId, checklist)
    return checklist
  }

  getChecklist(projectId: string, threadId: string): Checklist | null {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM checklists WHERE thread_id=?',
      threadId
    )
    return row ? (JSON.parse(row.data) as Checklist) : null
  }

  async updateChecklistItem(
    projectId: string,
    threadId: string,
    itemId: string,
    status: ChecklistItem['status'],
    evidence?: string
  ): Promise<Checklist | null> {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM checklists WHERE thread_id=?',
      threadId
    )
    if (!row) return null
    const checklist = JSON.parse(row.data) as Checklist

    const items = checklist.items.map((item) =>
      item.id === itemId ? { ...item, status, evidence: evidence ?? item.evidence } : item
    )

    const updated: Checklist = { ...checklist, items }
    this.db.run(
      'INSERT OR REPLACE INTO checklists(thread_id, data, created_at) VALUES(?,?,?)',
      threadId,
      JSON.stringify(updated),
      checklist.createdAt
    )
    await this.writeProgress(projectId, threadId, updated)
    return updated
  }

  private async writeProgress(
    projectId: string,
    threadId: string,
    checklist: Checklist
  ): Promise<void> {
    const featureSlug = await ensureFeatureSlug(this.db, projectId, threadId)
    const project = requireLocalProject(this.db, projectId)
    const lines = ['# Progress', '']
    for (const item of checklist.items) {
      const marker = item.status === 'complete' ? 'x' : ' '
      lines.push(`- [${marker}] ${item.content}`)
      if (item.evidence?.trim()) lines.push(`  - Evidence: ${item.evidence.trim()}`)
    }
    await this.storage.writeProjectSpecRaw(
      projectId,
      featureSlug,
      'progress.md',
      `${lines.join('\n')}\n`,
      project
    )
  }
}
