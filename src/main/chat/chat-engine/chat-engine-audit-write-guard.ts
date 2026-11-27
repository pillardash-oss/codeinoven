import { Logger } from '../../system/logger'
import type { ProjectFingerprint } from '../../git/change-tracking-service'
import type { ChatEngine } from '../chat-engine'

/** A project's stat fingerprint, captured before an audit turn ran. */
export interface AuditFingerprint {
  projectId: string
  projectPath: string
  fingerprint: ProjectFingerprint
}

/** How many changed paths an issue line names before it summarizes the rest. */
const ISSUE_PATH_LIMIT = 12

/**
 * The evidence issue that marks a report written by an auditor that changed the
 * tree it was reading.
 *
 * The report is kept, not discarded: the tokens are already spent, and the
 * findings still describe the code before the auditor's own edits, which is what
 * the user asked it to judge. What the report cannot claim is that its evidence is
 * clean, so it is persisted the same way an unverified report is: as a partial
 * report the studio flags, with this line saying exactly why.
 */
export function auditWorktreeIssues(paths: readonly string[]): string[] {
  if (paths.length === 0) return []
  const shown = paths.slice(0, ISSUE_PATH_LIMIT)
  const more = paths.length > shown.length ? ` and ${paths.length - shown.length} more` : ''
  return [
    `The Auditor modified ${paths.length} project ${paths.length === 1 ? 'file' : 'files'} while auditing: ${shown.join(', ')}${more}. The report was written before or beside those edits, so treat its evidence as unverified.`
  ]
}

/**
 * The after-the-run worktree check that keeps an audit honest without throwing
 * its work away.
 *
 * The prompt tells the auditor not to modify files and, where a harness supports
 * one, the turn carries a read-only sandbox. A harness that ignores it still has a
 * shell, so the project's stat fingerprint is taken before the run and compared
 * after each turn; whatever changed is reported as an evidence issue on the
 * report itself rather than killing the run.
 */
export class ChatEngineAuditWriteGuard {
  constructor(private readonly host: ChatEngine) {}

  /** The project's fingerprint, taken before an audit turn runs. */
  async capture(projectId: string, projectPath: string): Promise<AuditFingerprint | null> {
    try {
      const fingerprint = await this.host.checkpointManager.fingerprint(projectId, projectPath)
      return { projectId, projectPath, fingerprint }
    } catch (error) {
      // A project without a readable worktree cannot be fingerprinted; the audit
      // still runs, because refusing here would fail work the app cannot see.
      Logger.dev('Audit worktree fingerprint failed:', error)
      return null
    }
  }

  /**
   * Project-relative paths the auditor changed since the run started.
   *
   * Never throws: a fingerprint that cannot be compared leaves the report
   * unmarked instead of failing an audit that already ran.
   */
  async changedPaths(captured: AuditFingerprint | null): Promise<string[]> {
    if (!captured) return []
    try {
      const after = await this.host.checkpointManager.fingerprint(
        captured.projectId,
        captured.projectPath
      )
      return this.host.checkpointManager.diffFingerprints(
        captured.projectId,
        captured.fingerprint,
        after
      )
    } catch (error) {
      Logger.dev('Audit worktree verification failed:', error)
      return []
    }
  }
}
