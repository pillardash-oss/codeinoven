import { BrowserWindow } from 'electron'
import type {
  SkillInstallRecord,
  SkillUpdateResult,
  SkillUpdateStatus,
  UtilityDefinitionFor,
  UtilityScope
} from '../../lib/types'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { knownHarnessIds } from './skill-install'
import { Logger } from '../system/logger'
import {
  installMarketSkill,
  type MarketSkillInstallContext,
  type MarketSkillScope
} from './skill-install'
import { SkillInstallRecordStore } from './skill-install-records'
import { loadSkillMarketDetail } from './skill-market'
import { fetchUpstreamSkillVersion } from './skill-upstream'
import { UtilityRegistryService } from './utility-registry-service'

/**
 * Keeps the marketplace skills CodeInOven installed fresh.
 *
 * It rides the app-update check cycle (startup, every six hours, and an explicit
 * "Check for updates") because that is the cadence the user already expects for
 * "is there something newer". It owns only the copies CodeInOven placed: each
 * install writes a record, and a copy the user placed by hand with the `skills`
 * CLI has no record and is never rewritten.
 *
 * The pass is deliberately gentle. One skill at a time, a pause between them,
 * one repository read shared between the skills that came from it, a bounded
 * report, and a hard deadline after which the rest simply waits for the next
 * check. Every step is async I/O or a child process, so nothing here occupies
 * the main process while it runs.
 */

/** The app-update check runs every six hours; a skills pass never runs more often. */
const MIN_INTERVAL_MS = 6 * 60 * 60 * 1_000
/** A startup pass waits for the workspace to settle before touching the network. */
const START_DELAY_MS = 45_000
/** A breath between skills, so a pass never feels like a batch job on the machine. */
const BATCH_PAUSE_MS = 750
/** A pass gives up here; whatever is left waits for the next check. */
const PASS_DEADLINE_MS = 20 * 60 * 1_000
/** Ceiling on the report kept in memory and sent to the renderer. */
const MAX_RESULTS = 200
/** Consecutive unreachable sources that mean the machine is offline. */
const UNREACHABLE_LIMIT = 3

/** Push channel for background pass state. */
export const SKILL_UPDATE_EVENT = 'utilities:skillUpdates'

export interface SkillUpdateDeps {
  /** The same install path the marketplace uses, so updates land where installs do. */
  install: MarketSkillInstallContext
  /** Project ids that still exist; a copy whose project is gone is not updated. */
  listProjectIds: () => Promise<string[]>
}

/** The idle status, also used when the service is unavailable. */
export function idleSkillUpdateStatus(): SkillUpdateStatus {
  return {
    running: false,
    tracked: 0,
    lastCheckedAt: null,
    lastFinishedAt: null,
    updated: 0,
    results: []
  }
}

function identity(record: SkillInstallRecord): Omit<SkillUpdateResult, 'outcome' | 'detail'> {
  return {
    id: record.id,
    skillId: record.skillId,
    manager: record.manager,
    scope: record.scope,
    ...(record.projectId ? { projectId: record.projectId } : {})
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Which install scope a record replays through. */
function installScope(record: SkillInstallRecord): MarketSkillScope {
  if (record.scope === 'global') return 'global'
  return record.scope === 'project' ? 'projects' : 'harnesses'
}

/** Whether a registry utility's scope is the one this record installed into. */
function registryScopeMatches(scope: UtilityScope, record: SkillInstallRecord): boolean {
  if (record.scope === 'global' || !record.projectId) return scope.level === 'global'
  return (
    (scope.level === 'project' || scope.level === 'thread') && scope.projectId === record.projectId
  )
}

export class SkillUpdateService {
  private readonly store: SkillInstallRecordStore
  private readonly deps: SkillUpdateDeps
  private _status: SkillUpdateStatus = idleSkillUpdateStatus()
  private pass: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private lastStartedAt: number | null = null

  constructor(deps: SkillUpdateDeps) {
    this.deps = deps
    this.store = new SkillInstallRecordStore(deps.install.storage)
  }

  /**
   * Current state, with the tracked count read live so an install made since
   * the last pass shows up immediately instead of waiting for the next check.
   */
  async status(): Promise<SkillUpdateStatus> {
    const tracked = (await this.store.list().catch(() => [])).length
    return { ...this._status, tracked, results: [...this._status.results] }
  }

  /**
   * Called on every app-update check cycle. An explicit check runs a pass right
   * away; a background one waits a moment after startup and then keeps to the
   * same six-hour floor as the app check, so the two never drift apart or
   * stack up.
   */
  scheduleCheck(options: { explicit: boolean }): void {
    if (this.stopped || this.pass || this.timer) return
    if (
      !options.explicit &&
      this.lastStartedAt !== null &&
      Date.now() - this.lastStartedAt < MIN_INTERVAL_MS
    ) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = null
        void this.runPass()
      },
      options.explicit ? 0 : START_DELAY_MS
    )
  }

  /** User-initiated pass from the Utilities page; resolves when it finishes. */
  async checkNow(): Promise<SkillUpdateStatus> {
    if (!this.stopped) await this.runPass()
    return this.status()
  }
  stop(): void {
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private runPass(): Promise<void> {
    if (this.pass) return this.pass
    const pass = this.executePass()
      .catch((error: unknown) => {
        Logger.error('Skill update pass failed:', error)
        this.publish({
          ...this._status,
          running: false,
          lastFinishedAt: Date.now(),
          error: error instanceof Error ? error.message : 'The skill update pass failed'
        })
      })
      .finally(() => {
        this.pass = null
      })
    this.pass = pass
    return pass
  }

  private async executePass(): Promise<void> {
    const startedAt = Date.now()
    this.lastStartedAt = startedAt
    const records = await this.store.list()
    if (records.length === 0) {
      this.publish({
        running: false,
        tracked: 0,
        lastCheckedAt: startedAt,
        lastFinishedAt: Date.now(),
        updated: 0,
        results: []
      })
      return
    }
    this.publish({
      running: true,
      tracked: records.length,
      lastCheckedAt: startedAt,
      lastFinishedAt: this._status.lastFinishedAt,
      updated: 0,
      results: []
    })

    const projectIds = new Set(await this.deps.listProjectIds().catch(() => []))
    const results: SkillUpdateResult[] = []
    const checkedIds: string[] = []
    const updatedIds: string[] = []
    const deadline = startedAt + PASS_DEADLINE_MS
    let unreachable = 0
    let error: string | undefined

    for (const record of records) {
      if (this.stopped) break
      if (Date.now() > deadline) {
        error = 'The pass reached its time limit; the rest resumes on the next check.'
        break
      }
      const outcome = await this.updateRecord(record, projectIds)
      results.push(outcome.result)
      checkedIds.push(record.id)
      if (outcome.result.outcome === 'updated') updatedIds.push(record.id)
      unreachable = outcome.unreachable ? unreachable + 1 : 0
      if (unreachable >= UNREACHABLE_LIMIT) {
        error = 'Skill updates stopped early: the sources could not be reached.'
        break
      }
      if (results.length < records.length) await pause(BATCH_PAUSE_MS)
    }

    const finishedAt = Date.now()
    await this.store.markChecked(checkedIds, updatedIds, finishedAt)
    Logger.dev(
      `Skill updates: checked ${checkedIds.length}/${records.length}, updated ${updatedIds.length}`
    )
    this.publish({
      running: false,
      tracked: records.length,
      lastCheckedAt: startedAt,
      lastFinishedAt: finishedAt,
      updated: updatedIds.length,
      results: results.slice(-MAX_RESULTS),
      ...(error ? { error } : {})
    })
  }

  /** One skill, one verdict. `unreachable` feeds the offline circuit breaker. */
  private async updateRecord(
    record: SkillInstallRecord,
    projectIds: ReadonlySet<string>
  ): Promise<{ result: SkillUpdateResult; unreachable: boolean }> {
    try {
      if (record.projectId && !projectIds.has(record.projectId)) {
        return {
          result: {
            ...identity(record),
            outcome: 'untracked',
            detail: 'The project this copy was installed in is gone'
          },
          unreachable: false
        }
      }
      return record.manager === 'cio'
        ? await this.updateManagedRecord(record)
        : await this.updateNativeRecord(record)
    } catch (error: unknown) {
      return {
        result: {
          ...identity(record),
          outcome: 'failed',
          detail: error instanceof Error ? error.message : 'The skill could not be updated'
        },
        unreachable: false
      }
    }
  }

  /**
   * A CodeInOven-managed copy is prompt content, not a file: the registry holds
   * its `SKILL.md` and every turn reads it fresh, so an update is a registry
   * patch that the next turn already sees.
   */
  private async updateManagedRecord(
    record: SkillInstallRecord
  ): Promise<{ result: SkillUpdateResult; unreachable: boolean }> {
    const registry = new UtilityRegistryService(this.deps.install.storage)
    const managed = (await registry.list()).find(
      (utility): utility is UtilityDefinitionFor<'skill'> =>
        utility.kind === 'skill' &&
        utility.harnessBindings.some(
          (binding) => binding.strategy === 'skill' && binding.transportName === record.skillId
        ) &&
        registryScopeMatches(utility.scope, record)
    )
    if (!managed) {
      return {
        result: {
          ...identity(record),
          outcome: 'untracked',
          detail: 'CodeInOven no longer manages this skill'
        },
        unreachable: false
      }
    }
    let markdown: string
    let description: string
    try {
      const detail = await loadSkillMarketDetail(`${record.source}/${record.skillId}`)
      markdown = detail.skillMarkdown.trim()
      description = detail.description
    } catch (error: unknown) {
      return {
        result: {
          ...identity(record),
          outcome: 'failed',
          detail: error instanceof Error ? error.message : 'The source could not be read'
        },
        unreachable: true
      }
    }
    if (!markdown) {
      return {
        result: {
          ...identity(record),
          outcome: 'failed',
          detail: 'This source no longer exposes a readable SKILL.md'
        },
        unreachable: false
      }
    }
    if (markdown === managed.config.instructions) {
      return { result: { ...identity(record), outcome: 'current' }, unreachable: false }
    }
    await registry.update(managed.id, {
      config: {
        instructions: markdown,
        ...(managed.config.supportingFiles
          ? { supportingFiles: managed.config.supportingFiles }
          : {})
      },
      ...(description ? { description } : {})
    })
    return { result: { ...identity(record), outcome: 'updated' }, unreachable: false }
  }

  /**
   * A native copy is a real folder. Upstream truth is the git tree sha of the
   * skill's folder (the value the skills CLI itself compares), captured at
   * install time, so a check is one repository read and a re-install happens
   * only when that sha actually moved.
   */
  private async updateNativeRecord(
    record: SkillInstallRecord
  ): Promise<{ result: SkillUpdateResult; unreachable: boolean }> {
    const githubToken = (await this.deps.install.githubToken?.().catch(() => null)) ?? null
    const upstream = await fetchUpstreamSkillVersion({
      source: record.source,
      sourceType: record.sourceType,
      skillId: record.skillId,
      skillPath: record.skillPath,
      githubToken
    })
    if (!upstream) {
      return {
        result: {
          ...identity(record),
          outcome: 'failed',
          detail: 'This skill could not be read from its source'
        },
        unreachable: true
      }
    }
    if (record.upstreamHash === null) {
      await this.store.setUpstream([record.id], upstream)
      return {
        result: {
          ...identity(record),
          outcome: 'untracked',
          detail: 'Baseline recorded; changes are picked up from the next check'
        },
        unreachable: false
      }
    }
    if (upstream.hash === record.upstreamHash) {
      return { result: { ...identity(record), outcome: 'current' }, unreachable: false }
    }
    // A harness this copy was installed for can be uninstalled between passes;
    // there is nothing left to refresh in that case.
    const harnessIds = (record.harnessIds ?? []).filter((harnessId) =>
      knownHarnessIds().has(harnessId)
    )
    if (record.scope === 'harness' && harnessIds.length === 0) {
      return {
        result: {
          ...identity(record),
          outcome: 'untracked',
          detail: 'The harness this copy was installed for is no longer available'
        },
        unreachable: false
      }
    }
    await installMarketSkill(this.deps.install, {
      source: record.source,
      skillId: record.skillId,
      manager: 'native',
      scope: installScope(record),
      projectIds: record.projectId ? [record.projectId] : [],
      harnessIds
    })
    // Re-assert the version this pass already read, so a capture that failed
    // inside the install cannot leave the record looking stale for another pass.
    await this.store.setUpstream([record.id], upstream)
    return { result: { ...identity(record), outcome: 'updated' }, unreachable: false }
  }

  private publish(status: SkillUpdateStatus): void {
    this._status = status
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        sendToRenderer(window.webContents, SKILL_UPDATE_EVENT, status)
      }
    }
  }
}
