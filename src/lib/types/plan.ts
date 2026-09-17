export interface Plan {
  threadId: string
  content: string
  approved: boolean
  createdAt: number
  approvedAt?: number
}

export type ChecklistItemStatus = 'pending' | 'in_progress' | 'complete' | 'failed'

export interface ChecklistItem {
  id: string
  content: string
  status: ChecklistItemStatus
  threadId: string
  evidence?: string
  notes: string
}

export interface Checklist {
  threadId: string
  items: ChecklistItem[]
  immutable: boolean
  createdAt: number
}
