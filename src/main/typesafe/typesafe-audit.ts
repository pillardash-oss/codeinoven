import type {
  TypesafeAnswerMap,
  TypesafeDecisionStatus,
  TypesafeThresholds,
  TypesafeUsage
} from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
/** One line per decision, appended where every other app audit trail lives. */
const AUDIT_PATH = 'logs/typesafe-decisions.jsonl'

/** One recorded decision. */
export interface TypesafeAuditRecord {
  at: number
  /** Which seam asked. */
  seam: string
  /** Thread the decision belongs to, when it ran inside one. */
  threadId?: string
  status: TypesafeDecisionStatus
  /** Versioned model that answered, when one did. */
  model?: string
  requestId?: string
  latencyMs: number
  /** Question ids mapped to the primitive that asked them. */
  questions: Record<string, string>
  /** Raw answers, kept so a persisted judgment can be replayed and re-scored. */
  answers?: TypesafeAnswerMap
  /** Floors the answer was measured against. */
  thresholds: TypesafeThresholds
  /** Ids that fell short of their floor. */
  failed?: string[]
  usage?: TypesafeUsage
  /** Estimated cost of the call in USD, from the usage the service reported. */
  costUsd?: number
  /** Failure detail for a call that produced no answer. */
  detail?: string
}

/**
 * Append-only record of what the capability decided.
 *
 * A typed, persisted answer is what makes an auxiliary judgment reviewable
 * later: the raw probabilities are kept alongside the thresholds they were
 * measured against, so a decision can be re-scored without asking the service
 * again. Writing is best effort on purpose. A seam's own work must never fail
 * because an audit line could not be written.
 */
export class TypesafeAuditLog {
  constructor(private readonly storage: StorageEngine) {}

  async append(record: TypesafeAuditRecord): Promise<void> {
    try {
      await this.storage.appendRaw(AUDIT_PATH, `${JSON.stringify(record)}\n`)
    } catch (error) {
      // Best effort by design: a seam's own work must not fail because one
      // audit line could not be written.
      Logger.dev('TypeSafe decision could not be audited:', error)
    }
  }
}
