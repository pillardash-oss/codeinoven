import type { AssignmentPlan, AssignmentTask } from './assignment'
import type { ProviderCatalog, ThreadSettings } from './agent'
import type { Thread } from './thread'

/** Props for the Assignment coordinator board. */
export interface AssignmentCoordinatorPanelProps {
  assignment: AssignmentPlan
  threads: Thread[]
  auditThread?: Thread
  auditState?: Thread['auditState'] | 'failed'
  finalComplete?: boolean
  reportAvailable?: boolean
  selectedThreadId: string
  coordinatorWorking: boolean
  onOpenAssignment: () => void
  onOpenAuditWork?: () => void
  onViewReport?: () => void
  onOpenThread: (thread: Thread) => void
  onOpenTask: (task: AssignmentTask) => void
  onResume: () => void
  onStop: () => Promise<void>
  onResumeAssignment: () => Promise<void>
  /** Present only when the open thread is a worker/auditor child: returns to
   *  the Sr. Engineer that owns this Assignment. */
  onBackToCoordinator?: () => void
  /** Present only while the open thread is a not-reporting worker: switches its
   *  reporting back on and asks it to hand its finished work to the Sr. Engineer. */
  onReportToCoordinator?: () => Promise<void>
}

/** Props for the Achievement / durable-Audit coordinator board. */
export interface AchievementCoordinatorPanelProps {
  mode?: 'achievement' | 'audit'
  specTitle: string
  specSummary: string
  auditThread?: Thread
  auditState?: Thread['auditState']
  reportAvailable?: boolean
  /** The achievement loop verified the goal and closed itself; no further work remains. */
  achievementReached?: boolean
  selectedThreadId: string
  auditorSettings: ThreadSettings
  providers: ProviderCatalog[]
  projectId?: string | null
  favoriteModels?: string[]
  recentModels?: string[]
  coordinatorWorking: boolean
  onOpenAudit?: () => void
  onViewReport?: () => void
  onOpenThread: (thread: Thread) => void
  onResume?: () => void
  onModelChange: (settings: ThreadSettings) => void
  onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
  /** Removes one model from the recently-used history; shows the "x" on recent rows. */
  onRemoveRecent?: (modelKey: string) => void
  onReorderFavorite?: (draggedKey: string, targetKey: string, position: 'before' | 'after') => void
  /** Present only when the open thread is an auditor child: returns to the
   *  thread that owns this coordination. */
  onBackToCoordinator?: () => void
}

/** Props for the Independent (spec-less) Audit coordinator board. */
export interface IndependentAuditCoordinatorPanelProps {
  /** True while an independent audit run is in flight. */
  running?: boolean
  auditThread?: Thread
  reportAvailable?: boolean
  selectedThreadId: string
  auditorSettings: ThreadSettings
  providers: ProviderCatalog[]
  projectId?: string | null
  favoriteModels?: string[]
  recentModels?: string[]
  onOpenAudit?: () => void
  onViewReport?: () => void
  /** Delete the current auditor thread and start a fresh audit session. */
  onNewAudit?: () => void | Promise<void>
  /** Remove the auditor thread from its row menu, without starting an audit. */
  onDeleteThread?: (thread: Thread) => Promise<void>
  onOpenThread: (thread: Thread) => void
  onModelChange: (settings: ThreadSettings) => void
  onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
  /** Removes one model from the recently-used history; shows the "x" on recent rows. */
  onRemoveRecent?: (modelKey: string) => void
  onReorderFavorite?: (draggedKey: string, targetKey: string, position: 'before' | 'after') => void
  /** Present only when the open thread is an auditor child: returns to the
   *  thread that owns this audit. */
  onBackToCoordinator?: () => void
}
