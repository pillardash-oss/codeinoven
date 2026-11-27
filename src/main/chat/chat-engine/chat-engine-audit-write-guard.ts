import { Logger } from '../../system/logger'
import type { ProjectFingerprint } from '../../git/change-tracking-service'
import type { ChatEngine } from '../chat-engine'

/**
 * Raised when an audit turn changed the project it was auditing.
 *
 * An audit is a read of the delivered work. A run that edited the tree audited
 * its own patch, so its report describes code nobody delivered, and the worktree
 * the user signed off is gone. The run fails loudly instead of persisting that
 * report, and the paths it touched are named so nothing has to be guessed at.
 */
export class AuditModifiedWorktreeError extends Error {
  constructor(readonly paths: readonly string[]) {
    const shown = paths.slice(0, 12)
    const more = paths.length > shown.length ? `\n…and ${paths.length - shown.length} more` : ''
    super(
      [
        'The Auditor modified the project it was auditing, so this run is discarded instead of saved.',
        'An audit may only read the repository: a report from a run that patched the code describes work nobody delivered.',
        'Files this run changed:',
        ...shown.map((path) => `- ${path}`),
        more,
        'Review those changes, restore what the audit should not have touched, and run the audit again.'
      ]
        .filter(Boolean)
        .join('\n')
    )
    this.name = 'AuditModifiedWorktreeError'
  }
}

/** A project's stat fingerprint, captured before an audit turn ran. */
export interface AuditFingerprint {
  projectId: string
  projectPath: string
  fingerprint: ProjectFingerprint
}

/**
 * The before/after worktree check that keeps an audit read-only.
 *
 * The prompt tells the auditor not to modify files and the harness sandboxes
 * carry that instruction where the harness supports one, but a harness that
 * ignores the sandbox flag still has a shell. This is the one check that does not
 * depend on the harness behaving: the project's stat fingerprint is taken before
 * the audit's first turn and compared after each turn, and any difference fails
 * the run.
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
   * Compare the project against the fingerprint taken before the run and throw
   * when the auditor touched it.
   */
  async assertUnmodified(captured: AuditFingerprint | null): Promise<void> {
    if (!captured) return
    try {
      const after = await this.host.checkpointManager.fingerprint(
        captured.projectId,
        captured.projectPath
      )
      const changed = this.host.checkpointManager.diffFingerprints(
        captured.projectId,
        captured.fingerprint,
        after
      )
      if (changed.length === 0) return
      throw new AuditModifiedWorktreeError([...new Set(changed)].sort())
    } catch (error) {
      if (error instanceof AuditModifiedWorktreeError) throw error
      Logger.dev('Audit worktree verification failed:', error)
    }
  }
}
