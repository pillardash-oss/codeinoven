import { randomUUID } from 'node:crypto'
import {
  type OvenSetupConfiguration,
  type OvenSetupGitConfiguration,
  type OvenSetupOperation,
  type OvenSetupOperationStatus,
  type OvenSetupPhase,
  type OvenSetupProgressEvent,
  type OvenSetupSelectedHarness,
  type OvenSetupStep,
  type OvenSetupStepStatus,
  type OvenPreflightAssessment,
  type OvenPreflightReport
} from '../../lib/ovens'
import { buildSetupPlan, plannedStepsToSetupSteps, type SetupPlan } from './remote/oven-setup-script'
import { assessPreflight } from './oven-setup-capabilities'
import { OVEN_SETUP_SCRIPT_VERSION } from './oven-setup-bootstrap'
import { sshQuote, type OvenSsh } from './oven-ssh'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { withOvenHarnessMutation } from './oven-operation-lock'

const OPERATION_PATH = 'ovens/setup'
/** Bounded so a long setup cannot grow the journal without limit. */
const MAX_JOURNAL_EVENTS = 200
const PACKAGE_TIMEOUT_MS = 15 * 60_000
const INSTALL_TIMEOUT_MS = 10 * 60_000
const VERIFY_TIMEOUT_MS = 30_000
const STEP_TIMEOUT_MS = 5 * 60_000

export interface OvenSetupPorts {
  ssh: OvenSsh
  /** Read-only observation of the oven. */
  preflight: (ovenId: string) => Promise<OvenPreflightReport>
  /** Install the current CodeInOven oven service. */
  installService: (ovenId: string) => Promise<void>
  /** Copy selected accounts and portable configuration. Returns readiness issues. */
  syncAccounts: (
    ovenId: string,
    selections: OvenSetupSelectedHarness[],
    synchronizeConfiguration: boolean
  ) => Promise<string[]>
  /** Install and verify the dedicated Git identity. Returns readiness issues. */
  configureGit: (ovenId: string, configuration: OvenSetupGitConfiguration) => Promise<string[]>
  /** Wait until a selected harness has no active Oven run before changing it. */
  waitForHarnessIdle?: (ovenId: string, command: string) => Promise<void>
}

interface Journal {
  sequence: number
  events: OvenSetupProgressEvent[]
}

export interface OvenSetupPreflightResult {
  report: OvenPreflightReport
  assessment: OvenPreflightAssessment
}

/** Phases, in order. Every step belongs to exactly one. */
const PHASE_ORDER: readonly OvenSetupPhase[] = [
  'preflight',
  'bootstrap',
  'prerequisites',
  'harnesses',
  'accounts',
  'git',
  'finalize'
]

const UNCERTAIN_MESSAGES = [
  'disconnected',
  'timed out',
  'before the connection timeout',
  'SSH connection failed',
  'did not respond'
]

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** True when the failure leaves the remote state unknown rather than not-done. */
export function isUncertainFailure(message: string): boolean {
  const normalized = message.toLowerCase()
  return UNCERTAIN_MESSAGES.some((marker) => normalized.includes(marker.toLowerCase()))
}

/**
 * Runs oven setup: one mutating operation per oven, persisted so it survives an
 * app restart, retried without repeating verified work, and cancelled without
 * claiming an uncertain remote command either succeeded or failed.
 */
export class OvenSetupService {
  private readonly operations = new Map<string, OvenSetupOperation>()
  private readonly journals = new Map<string, Journal>()
  private readonly plans = new Map<string, SetupPlan>()
  private readonly running = new Set<string>()
  private readonly cancellations = new Set<string>()
  private readonly reports = new Map<string, OvenPreflightReport>()
  private recovered = false

  constructor(
    private readonly storage: StorageEngine,
    private readonly ports: OvenSetupPorts
  ) {}

  /**
   * Classify anything left mid-flight by a previous process as interrupted.
   * Nothing is assumed complete: the steps that were running are re-observed on
   * the next run before the oven is touched again.
   */
  async recover(): Promise<number> {
    const directories = await this.storage.listDirectories(OPERATION_PATH).catch(() => [] as string[])
    let recoveredCount = 0
    for (const entry of directories.slice(0, 64)) {
      const ovenId = entry.split('/').filter(Boolean).pop()
      if (!ovenId) continue
      const stored = await this.storage.read<OvenSetupOperation>(`${OPERATION_PATH}/${ovenId}.json`)
      if (!stored) continue
      if (stored.status === 'running' || stored.status === 'preparing') {
        for (const step of stored.steps)
          if (step.status === 'running') {
            step.status = 'interrupted'
            step.error = 'CodeInOven closed while this step was running. Its result is re-checked before setup continues.'
          }
        stored.status = 'interrupted'
        stored.updatedAt = Date.now()
        await this.persist(stored)
        recoveredCount++
      }
      this.operations.set(ovenId, stored)
    }
    this.recovered = true
    return recoveredCount
  }

  /** Read-only observation plus the pure verdict. Never mutates the oven. */
  async preflight(ovenId: string): Promise<OvenSetupPreflightResult> {
    await this.ensureRecovered()
    const report = await this.ports.preflight(ovenId)
    const assessment = assessPreflight(report)
    this.reports.set(ovenId, report)
    return { report, assessment }
  }

  /**
   * Start setup. Re-running while a mutating operation is already active
   * returns that operation rather than starting a second one.
   */
  async startSetup(ovenId: string, configuration: OvenSetupConfiguration): Promise<OvenSetupOperation> {
    await this.ensureRecovered()
    const existing = this.operations.get(ovenId)
    if (existing && isActive(existing.status)) {
      Logger.dev('Oven setup already active', { ovenId, operationId: existing.id })
      return existing
    }
    const { assessment } = await this.preflight(ovenId)
    const blockers = assessment.issues.filter((issue) => issue.blocking)
    if (blockers.length > 0)
      throw new Error(`${blockers[0]?.message} Fix this on the Oven, then run setup again.`)

    const plan = buildSetupPlan(assessment, configuration)
    if (plan.blockers.length > 0)
      throw new Error(`${plan.blockers[0]} Fix this on the Oven, then run setup again.`)
    const operation: OvenSetupOperation = {
      id: randomUUID(),
      ovenId,
      status: 'running',
      setupComplete: existing?.setupComplete === true || existing?.status === 'succeeded',
      configuration,
      steps: plannedStepsToSetupSteps(plan),
      startedAt: Date.now(),
      updatedAt: Date.now()
    }
    this.operations.set(ovenId, operation)
    this.plans.set(ovenId, plan)
    this.journals.set(ovenId, { sequence: 0, events: [] })
    await this.persist(operation)
    await this.publish(ovenId, plan.steps[0]?.phase ?? 'preflight', plan.steps[0]?.id)
    void this.execute(ovenId)
    return operation
  }

  /**
   * Retry after a failure or a blocked elevation. Completed steps are
   * revalidated rather than blindly skipped, and steps with no stored evidence
   * of success always run again.
   */
  async retrySetup(ovenId: string): Promise<OvenSetupOperation> {
    await this.ensureRecovered()
    const operation = this.operations.get(ovenId)
    if (!operation) throw new Error('There is no oven setup operation to retry.')
    if (isActive(operation.status))
      throw new Error('This oven setup is still running.')
    const plan = this.plans.get(ovenId)
    if (!plan)
      throw new Error('The setup plan for this oven is no longer available. Start setup again.')

    const report = await this.ports.preflight(ovenId)
    const assessment = assessPreflight(report)
    const refreshed = buildSetupPlan(assessment, operation.configuration)
    if (refreshed.blockers.length > 0)
      throw new Error(`${refreshed.blockers[0]} Fix this on the Oven, then retry setup.`)
    this.plans.set(ovenId, refreshed)
    this.reports.set(ovenId, report)
    // A plan whose shape changed means the oven moved under a paused operation.
    // Rather than resuming into an unknown state, restart the plan from the top:
    // every step is idempotent and re-verifies itself before it succeeds.
    const planChanged = refreshed.steps.some((planned, index) => planned.id !== plan.steps[index]?.id)

    operation.status = 'running'
    operation.error = undefined
    operation.finishedAt = undefined
    operation.updatedAt = Date.now()
    if (planChanged) operation.steps = plannedStepsToSetupSteps(refreshed)
    else for (const step of operation.steps) step.retryCount = (step.retryCount ?? 0) + 1
    await this.persist(operation)
    await this.publish(ovenId, refreshed.steps[0]?.phase ?? 'preflight', refreshed.steps[0]?.id)
    void this.execute(ovenId)
    return operation
  }

  /** Stop scheduling work. The in-flight command is never assumed either way. */
  async cancelSetup(ovenId: string): Promise<OvenSetupOperation> {
    const operation = this.operations.get(ovenId)
    if (!operation) throw new Error('There is no oven setup operation to cancel.')
    this.cancellations.add(ovenId)
    if (!isActive(operation.status)) return operation
    for (const step of operation.steps)
      if (step.status === 'running' || step.status === 'pending') step.status = 'cancelled'
    operation.status = 'cancelled'
    operation.finishedAt = Date.now()
    operation.updatedAt = Date.now()
    await this.persist(operation)
    await this.publish(ovenId, 'finalize', undefined, 'Setup cancelled. Completed steps were kept.')
    return operation
  }

  async getOperationForOven(ovenId: string): Promise<OvenSetupOperation | null> {
    await this.ensureRecovered()
    return this.operations.get(ovenId) ?? null
  }

  /** Bounded, resumable progress. `after` is the last sequence the caller saw. */
  async progress(
    ovenId: string,
    after = 0
  ): Promise<{ events: OvenSetupProgressEvent[]; hasMore: boolean }> {
    await this.ensureRecovered()
    let journal = this.journals.get(ovenId)
    if (!journal) {
      const stored = await this.storage.read<Journal>(`${OPERATION_PATH}/${ovenId}.journal.json`)
      journal = stored ?? { sequence: 0, events: [] }
      this.journals.set(ovenId, journal)
    }
    if (!Number.isSafeInteger(after) || after < 0) after = 0
    const events = journal.events.filter((entry) => entry.sequence > after)
    return { events, hasMore: events.length < journal.events.length }
  }

  private async execute(ovenId: string): Promise<void> {
    if (this.running.has(ovenId)) return
    this.running.add(ovenId)
    try {
      await this.runSteps(ovenId)
    } catch (error) {
      Logger.error('Oven setup failed unexpectedly', { ovenId, error: messageOf(error) })
      await this.fail(ovenId, messageOf(error))
    } finally {
      this.running.delete(ovenId)
      this.cancellations.delete(ovenId)
    }
  }

  private async runSteps(ovenId: string): Promise<void> {
    const plan = this.plans.get(ovenId)
    const operation = this.operations.get(ovenId)
    if (!plan || !operation) return

    for (const planned of plan.steps) {
      const step = operation.steps.find((entry) => entry.id === planned.id)
      if (!step) continue
      if (this.cancellations.has(ovenId)) return
      /* Verified work is not repeated; interrupted and failed work always is. */
      if (step.status === 'succeeded') continue
      if (planned.skippedReason) {
        step.status = 'skipped'
        step.skippedReason = planned.skippedReason
        step.finishedAt = Date.now()
        step.durationMs = 0
        continue
      }
      await this.runStep(ovenId, operation, step, planned)
      if (operation.status === 'failed' || operation.status === 'blocked') return
      if (this.cancellations.has(ovenId)) return
    }

    operation.status = 'succeeded'
    operation.setupComplete = true
    operation.finishedAt = Date.now()
    operation.updatedAt = Date.now()
    await this.persist(operation)
    await this.publish(ovenId, 'finalize', undefined, 'Oven setup finished.')
  }

  private async runStep(
    ovenId: string,
    operation: OvenSetupOperation,
    step: OvenSetupStep,
    planned: SetupPlan['steps'][number]
  ): Promise<void> {
    step.status = 'running'
    step.startedAt = Date.now()
    step.finishedAt = undefined
    step.error = undefined
    step.detail = planned.detail
    operation.status = 'running'
    operation.updatedAt = Date.now()
    await this.persist(operation)
    await this.publish(ovenId, planned.phase, step.id)

    const started = Date.now()
    try {
      if (planned.handledByApp) await this.runAppStep(ovenId, operation, planned)
      else await this.runShellStep(ovenId, planned)

      if (planned.verify) await this.verify(ovenId, planned)
      step.status = 'succeeded'
    } catch (error) {
      const message = messageOf(error)
      step.finishedAt = Date.now()
      step.durationMs = Date.now() - started
      if (planned.requiresElevation && isElevationRefusal(message)) {
        step.status = 'blocked'
        step.error = `${message} Setup cannot continue past this step without that access.`
        operation.status = 'blocked'
        operation.error = step.error
      } else {
        step.status = isUncertainFailure(message) ? 'interrupted' : 'failed'
        step.error = message
        operation.status = 'failed'
        operation.error = message
      }
      operation.finishedAt = Date.now()
      operation.updatedAt = Date.now()
      await this.persist(operation)
      await this.publish(ovenId, planned.phase, step.id, message)
      return
    }
    step.finishedAt = Date.now()
    step.durationMs = Date.now() - started
    operation.updatedAt = Date.now()
    await this.persist(operation)
    await this.publish(ovenId, planned.phase, step.id)
  }

  /** Steps the app performs itself, over its own authenticated boundaries. */
  private async runAppStep(
    ovenId: string,
    operation: OvenSetupOperation,
    planned: SetupPlan['steps'][number]
  ): Promise<void> {
    const step = operation.steps.find((entry) => entry.id === planned.id)
    switch (planned.id) {
      case 'preflight': {
        const report = await this.ports.preflight(ovenId)
        this.reports.set(ovenId, report)
        const assessment = assessPreflight(report)
        if (!assessment.supported) {
          const blocker = assessment.issues.find((issue) => issue.blocking)
          throw new Error(blocker?.message ?? 'This Oven platform is not supported.')
        }
        return
      }
      case 'accounts': {
        if (step) step.detail = 'Copying selected accounts and portable configuration into the oven.'
        const issues = await this.ports.syncAccounts(
          ovenId,
          operation.configuration.selectedHarnesses.filter((entry) => entry.accountId),
          operation.configuration.synchronizeConfiguration
        )
        if (issues.length > 0) throw new Error(issues[0])
        return
      }
      case 'git-identity': {
        const issues = await this.ports.configureGit(ovenId, operation.configuration.git)
        if (issues.length > 0) throw new Error(issues[0])
        return
      }
      case 'service':
        await this.ports.installService(ovenId)
        return
      case 'verify': {
        const report = await this.ports.preflight(ovenId)
        this.reports.set(ovenId, report)
        const stillMissing = report.harnesses.filter(
          (harness) =>
            harness.supported &&
            (harness.health === 'missing' || harness.health === 'broken')
        )
        if (step && stillMissing.length > 0)
          step.detail = `${stillMissing.length} harness${stillMissing.length === 1 ? '' : 'es'} still need attention.`
        return
      }
      default:
        return
    }
  }

  /**
   * Steps the oven runs. Every command is structured argv quoted once here, and
   * elevation uses `sudo -n` so a refused password never blocks on a prompt the
   * user cannot see or answer.
   */
  private async runShellStep(ovenId: string, planned: SetupPlan['steps'][number]): Promise<void> {
    const execute = async (): Promise<void> => {
      if (planned.phase === 'harnesses' && planned.verify?.command)
        await this.ports.waitForHarnessIdle?.(ovenId, planned.verify.command)
      for (const entry of planned.commands) {
        if (this.cancellations.has(ovenId))
          throw new Error('Setup was cancelled before this command started.')
        const argv = entry.elevated ? ['-n', entry.command, ...entry.args] : [entry.command, ...entry.args]
        const line = (entry.elevated ? ['sudo', ...argv] : argv).map(sshQuote).join(' ')
        const timeout =
          planned.id === 'packages' ? PACKAGE_TIMEOUT_MS : planned.phase === 'harnesses' ? INSTALL_TIMEOUT_MS : STEP_TIMEOUT_MS
        await this.ports.ssh.execute(ovenId, line, '', timeout)
      }
    }
    if (planned.phase === 'harnesses' && planned.verify?.command)
      await withOvenHarnessMutation(ovenId, planned.verify.command, execute)
    else await execute()
  }

  /** Decide success by reading the oven back, never by trusting an exit code. */
  private async verify(ovenId: string, planned: SetupPlan['steps'][number]): Promise<void> {
    if (!planned.verify) return
    const line = planned.id === 'node'
      ? `${sshQuote('node')} ${sshQuote('-e')} ${sshQuote('if(Number(process.versions.node.split(String.fromCharCode(46))[0])<22)process.exit(1)')}`
      : [planned.verify.command, ...planned.verify.args].map(sshQuote).join(' ')
    await this.ports.ssh.execute(ovenId, line, '', VERIFY_TIMEOUT_MS)
  }

  private async fail(ovenId: string, error: string): Promise<void> {
    const operation = this.operations.get(ovenId)
    if (!operation || !isActive(operation.status)) return
    operation.status = 'failed'
    operation.error = error
    operation.finishedAt = Date.now()
    operation.updatedAt = Date.now()
    await this.persist(operation)
    await this.publish(ovenId, 'finalize', undefined, error)
  }

  private async ensureRecovered(): Promise<void> {
    if (this.recovered) return
    await this.recover()
  }

  private async persist(operation: OvenSetupOperation): Promise<void> {
    try {
      await this.storage.write(`${OPERATION_PATH}/${operation.ovenId}.json`, operation)
    } catch (error) {
      Logger.error('Could not persist oven setup progress', {
        ovenId: operation.ovenId,
        error: messageOf(error)
      })
    }
  }

  /** Append one bounded, secret-free progress event. */
  private async publish(
    ovenId: string,
    phase: OvenSetupPhase,
    currentStepId?: string,
    message?: string
  ): Promise<void> {
    const operation = this.operations.get(ovenId)
    if (!operation) return
    const journal = this.journals.get(ovenId) ?? { sequence: 0, events: [] }
    const event: OvenSetupProgressEvent = {
      sequence: ++journal.sequence,
      operationId: operation.id,
      ovenId,
      status: operation.status,
      phase,
      steps: operation.steps.map(summarizeStep),
      ...(currentStepId ? { currentStepId } : {}),
      startedAt: operation.startedAt,
      ...(operation.finishedAt ? { finishedAt: operation.finishedAt } : {}),
      ...(operation.error ? { error: operation.error } : {}),
      ...(message ? { message } : {})
    }
    journal.events.push(event)
    if (journal.events.length > MAX_JOURNAL_EVENTS)
      journal.events.splice(0, journal.events.length - MAX_JOURNAL_EVENTS)
    this.journals.set(ovenId, journal)
    try {
      await this.storage.write(`${OPERATION_PATH}/${ovenId}.journal.json`, journal)
    } catch (error) {
      Logger.error('Could not persist oven setup journal', { ovenId, error: messageOf(error) })
    }
  }
}

/** Copy only the fields the renderer needs. Keeps the journal small. */
function summarizeStep(step: OvenSetupStep): OvenSetupStep {
  return {
    id: step.id,
    name: step.name,
    status: step.status,
    ...(step.startedAt ? { startedAt: step.startedAt } : {}),
    ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
    ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
    ...(step.error ? { error: step.error } : {}),
    ...(step.detail ? { detail: step.detail } : {}),
    ...(step.retryCount ? { retryCount: step.retryCount } : {}),
    ...(step.skippedReason ? { skippedReason: step.skippedReason } : {}),
    ...(step.requiresElevation ? { requiresElevation: true } : {})
  }
}

export function isActive(status: OvenSetupOperationStatus): boolean {
  return status === 'preparing' || status === 'running'
}

function isElevationRefusal(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('permission denied') ||
    normalized.includes('sudo: a password is required') ||
    normalized.includes('not in the sudoers') ||
    normalized.includes('administrator')
  )
}

export { PHASE_ORDER, OVEN_SETUP_SCRIPT_VERSION }
export type { OvenSetupStepStatus }
