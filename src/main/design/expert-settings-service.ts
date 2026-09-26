import {
  effectiveExperts,
  expertSignature,
  expertSummaries,
  type EffectiveExperts,
  type ThreadExpertDecision
} from '../../lib/experts'
import type { ExpertDecisionInput, ThreadExpertState } from '../../lib/ipc/expert'
import type { AuthoredWorkKind } from '../../lib/ipc/design'
import { requireLocalProjectViaWorker } from '../../lib/project-artifacts'
import type { AppConfig } from '../../lib/types'
import type { Database } from '../database/database'
import { ExpertSettingsRepo } from '../database/repositories/expert-settings-repo'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'

/**
 * The one place the app answers "may this thread delegate, and to whom".
 *
 * Three callers need that answer and they must not each derive it: the card that
 * asks the user before a session's first send, the playbook a session's turn
 * carries, and the `delegate` operation that would run an assigned model. A
 * second derivation is how a thread the user muted would still hear its expert
 * list described, or how `delegate` would refuse work the playbook went on
 * offering. So the decision is stored here, the effective list is computed here,
 * and every caller asks this service.
 */

export interface ExpertSettingsOptions {
  database: Database
  /** The live app config. Read per call so a settings change applies at once. */
  config: () => Promise<AppConfig>
  /**
   * Which authored-work session a thread is already in, or null for none.
   *
   * Supplied by the design service, which owns that detection, so the card and
   * the coordinator can never disagree about whether a thread is designing or
   * editing. Async because the answer is read on the database worker: this runs
   * on the path that draws a thread's card.
   */
  sessionKind?: (projectId: string, threadId: string) => Promise<AuthoredWorkKind | null>
}

/** Ceiling on an identifier this service will look up. */
const MAX_ID_LENGTH = 240

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

export class ExpertSettingsService {
  private readonly repo: ExpertSettingsRepo

  constructor(private readonly options: ExpertSettingsOptions) {
    this.repo = new ExpertSettingsRepo(options.database)
  }

  registerIpc(): void {
    ipcMain.handle('experts:state', async (_event, rawProjectId, rawThreadId) =>
      this.stateFor(requireId(rawProjectId, 'project id'), requireId(rawThreadId, 'thread id'))
    )
    ipcMain.handle('experts:decide', async (_event, rawProjectId, rawThreadId, rawInput: unknown) =>
      this.decide(
        requireId(rawProjectId, 'project id'),
        requireId(rawThreadId, 'thread id'),
        validateDecisionInput(rawInput)
      )
    )
  }

  /** The thread's recorded answer, or null before it has ever been asked. */
  decisionFor(threadId: string): ThreadExpertDecision | null {
    return this.repo.forThread(threadId)
  }

  /**
   * What this thread's session may delegate to, and why, when it may use none.
   *
   * The single answer the playbook and `delegate` both work from, so a session
   * the user muted cannot be described one way and run another.
   */
  async effectiveFor(threadId: string): Promise<EffectiveExperts> {
    const config = await this.options.config()
    return effectiveExperts(config.design?.assignments, this.repo.forThread(threadId))
  }

  /** Everything a surface needs about one thread's experts, right now. */
  async stateFor(projectId: string, threadId: string): Promise<ThreadExpertState> {
    await requireLocalProjectViaWorker(this.options.database, projectId)
    const assignments = (await this.options.config()).design?.assignments
    return {
      threadId,
      decision: this.repo.forThread(threadId),
      signature: expertSignature(assignments),
      // The card lists every expert the user staffed, including under a mute: a
      // user who turned them off for this thread still needs to see who they
      // turned off, and the switch that brings them back.
      experts: expertSummaries(assignments),
      session: (await this.options.sessionKind?.(projectId, threadId)) ?? null
    }
  }

  /**
   * Record the answer the card produced.
   *
   * The signature is captured from the experts as they are now, because that is
   * what makes the answer expire correctly: the user answered about this set, and
   * the card returns only when the set is no longer this one.
   */
  async decide(
    projectId: string,
    threadId: string,
    input: ExpertDecisionInput
  ): Promise<ThreadExpertState> {
    await requireLocalProjectViaWorker(this.options.database, projectId)
    const assignments = (await this.options.config()).design?.assignments
    this.repo.upsert(threadId, {
      choice: input.choice,
      silent: input.silent === true,
      signature: expertSignature(assignments),
      decidedAt: Date.now()
    })
    return this.stateFor(projectId, threadId)
  }

  /** Forget a thread's answer when the thread itself is gone. */
  forgetThread(threadId: string): void {
    this.repo.deleteThread(threadId)
  }
}

/** Validate the card's answer at the IPC boundary. */
function validateDecisionInput(value: unknown): ExpertDecisionInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expert decision must be an object')
  }
  const record = value as Record<string, unknown>
  const choice = record['choice']
  if (choice !== 'all' && choice !== 'off') {
    throw new TypeError('Expert decision must choose "all" or "off"')
  }
  const silent = record['silent']
  if (silent !== undefined && typeof silent !== 'boolean') {
    throw new TypeError('Expert decision silent flag must be a boolean')
  }
  return { choice, ...(silent === undefined ? {} : { silent }) }
}
