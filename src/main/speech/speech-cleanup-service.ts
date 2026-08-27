import type { SpeechCleanupProvenance, SpeechScope } from '../../lib/speech/types'

export interface SpeechCleanupResult {
  text: string
  provenance: SpeechCleanupProvenance
}

/**
 * Cleanup text itself is produced by the instruct LLM (or the consented remote
 * model). This service only owns the failure contract: a failed cleanup always
 * returns the raw transcript so nothing blocks dictation.
 */
export class SpeechCleanupService {
  fallback(raw: string, cause: unknown): SpeechCleanupResult {
    return {
      text: raw,
      provenance: {
        mode: 'local',
        appliedLessonIds: [],
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
