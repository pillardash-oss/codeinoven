import type {
  SpeechCleanupProvenance,
  SpeechCorrectionRule,
  SpeechScope
} from '../../lib/speech/types'

export interface SpeechCleanupResult {
  text: string
  provenance: SpeechCleanupProvenance
}

/** Applies learned rules deterministically after the selected local punctuation model. */
export class SpeechCleanupService {
  applyRules(text: string, rules: SpeechCorrectionRule[]): SpeechCleanupResult {
    let cleaned = text
    const appliedRuleIds: string[] = []
    for (const rule of rules) {
      if (!rule.enabled || rule.confidence < 0.7) continue
      const escaped = rule.source.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
      const expression = new RegExp(`\\b${escaped}\\b`, 'giu')
      const next = cleaned.replace(expression, rule.replacement)
      if (next !== cleaned) appliedRuleIds.push(rule.id)
      cleaned = next
    }
    return {
      text: cleaned,
      provenance: { mode: 'local', appliedRuleIds, failed: false }
    }
  }

  fallback(raw: string, cause: unknown): SpeechCleanupResult {
    return {
      text: raw,
      provenance: {
        mode: 'local',
        appliedRuleIds: [],
        failed: true,
        error: {
          code: 'cleanup-failed',
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: true
        }
      }
    }
  }

  minimalRemoteContext(scope: SpeechScope): { view: 'project' | 'inbox'; projectId?: string } {
    return scope.kind === 'project'
      ? { view: 'project', projectId: scope.projectId }
      : { view: 'inbox' }
  }
}
