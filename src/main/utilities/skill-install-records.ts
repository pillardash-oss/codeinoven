import type { SkillInstallRecord } from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'

/** Config-root path of the record file. Never in the project tree. */
const RECORDS_PATH = 'skills/installs.json'
const RECORDS_VERSION = 1

/** What a caller knows about one install; the store owns identity and history. */
export interface SkillInstallRecordInput {
  skillId: string
  manager: SkillInstallRecord['manager']
  source: string
  sourceType: SkillInstallRecord['sourceType']
  scope: SkillInstallRecord['scope']
  projectId?: string
  harnessIds?: string[]
  activation?: SkillInstallRecord['activation']
}

interface RecordsFile {
  version: number
  records: SkillInstallRecord[]
}

/** Stable identity of one install, so a re-install updates instead of duplicating. */
export function skillInstallRecordId(
  manager: SkillInstallRecord['manager'],
  skillId: string,
  scope: SkillInstallRecord['scope'],
  projectId: string | undefined
): string {
  return `${manager}:${skillId}:${scope}:${projectId ?? 'all'}`
}

function parseRecord(value: unknown): SkillInstallRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = record['id']
  const skillId = record['skillId']
  const manager = record['manager']
  const source = record['source']
  const sourceType = record['sourceType']
  const scope = record['scope']
  const installedAt = record['installedAt']
  if (
    typeof id !== 'string' ||
    typeof skillId !== 'string' ||
    (manager !== 'cio' && manager !== 'native') ||
    typeof source !== 'string' ||
    (sourceType !== 'github' && sourceType !== 'well-known') ||
    (scope !== 'global' && scope !== 'project' && scope !== 'harness') ||
    typeof installedAt !== 'number'
  ) {
    return null
  }
  const projectId = record['projectId']
  const harnessIds = record['harnessIds']
  const activation = record['activation']
  const lastCheckedAt = record['lastCheckedAt']
  const lastUpdatedAt = record['lastUpdatedAt']
  const upstreamHash = record['upstreamHash']
  const skillPath = record['skillPath']
  return {
    id,
    skillId,
    manager,
    source,
    sourceType,
    scope,
    ...(typeof projectId === 'string' ? { projectId } : {}),
    ...(Array.isArray(harnessIds)
      ? { harnessIds: harnessIds.filter((value): value is string => typeof value === 'string') }
      : {}),
    ...(activation === 'always' || activation === 'on_demand' ? { activation } : {}),
    upstreamHash: typeof upstreamHash === 'string' ? upstreamHash : null,
    skillPath: typeof skillPath === 'string' ? skillPath : null,
    installedAt,
    lastCheckedAt: typeof lastCheckedAt === 'number' ? lastCheckedAt : null,
    lastUpdatedAt: typeof lastUpdatedAt === 'number' ? lastUpdatedAt : null
  }
}

/**
 * The skills CodeInOven installed.
 *
 * The Skills CLI lock file cannot say who installed a skill, so the app keeps
 * its own record at install time. That record is what makes "only update what
 * CodeInOven installed" true: a skill the user placed by hand never appears
 * here, and the background updater never touches it.
 *
 * Writes are serialized in-process, because installs can land concurrently and
 * a read-modify-write on one JSON file would otherwise lose records.
 */
export class SkillInstallRecordStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  async list(): Promise<SkillInstallRecord[]> {
    const file = await this.storage.read<RecordsFile>(RECORDS_PATH)
    if (!file || file.version !== RECORDS_VERSION || !Array.isArray(file.records)) return []
    return file.records.flatMap((record) => {
      const parsed = parseRecord(record)
      return parsed ? [parsed] : []
    })
  }

  /** Add or refresh records, preserving each install's original timestamp. */
  async upsert(inputs: readonly SkillInstallRecordInput[]): Promise<void> {
    if (inputs.length === 0) return
    await this.mutate((records) => {
      const now = Date.now()
      for (const input of inputs) {
        const id = skillInstallRecordId(input.manager, input.skillId, input.scope, input.projectId)
        const existing = records.find((record) => record.id === id)
        const next: SkillInstallRecord = {
          id,
          skillId: input.skillId,
          manager: input.manager,
          source: input.source,
          sourceType: input.sourceType,
          scope: input.scope,
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.harnessIds?.length ? { harnessIds: input.harnessIds } : {}),
          ...(input.activation ? { activation: input.activation } : {}),
          upstreamHash: existing?.upstreamHash ?? null,
          skillPath: existing?.skillPath ?? null,
          installedAt: existing?.installedAt ?? now,
          lastCheckedAt: existing?.lastCheckedAt ?? null,
          lastUpdatedAt: existing?.lastUpdatedAt ?? null
        }
        if (existing) records[records.indexOf(existing)] = next
        else records.push(next)
      }
    })
  }

  /**
   * Record the upstream identity a copy was just installed from, so the next
   * background pass can tell whether upstream moved without re-reading the
   * skills CLI lock files (a project lock carries no comparable hash).
   */
  async setUpstream(
    ids: readonly string[],
    upstream: { hash: string; skillPath: string | null } | null
  ): Promise<void> {
    if (ids.length === 0 || !upstream) return
    const targets = new Set(ids)
    await this.mutate((records) => {
      for (const record of records) {
        if (!targets.has(record.id)) continue
        record.upstreamHash = upstream.hash
        record.skillPath = upstream.skillPath
      }
    })
  }

  /** Record that a pass looked at these installs, and which it rewrote. */
  async markChecked(
    checkedIds: readonly string[],
    updatedIds: readonly string[],
    checkedAt: number
  ): Promise<void> {
    if (checkedIds.length === 0) return
    const checked = new Set(checkedIds)
    const updated = new Set(updatedIds)
    await this.mutate((records) => {
      for (const record of records) {
        if (!checked.has(record.id)) continue
        record.lastCheckedAt = checkedAt
        if (updated.has(record.id)) record.lastUpdatedAt = checkedAt
      }
    })
  }

  /** Forget every install of one skill, whatever scope created it. */
  async removeSkill(skillId: string): Promise<void> {
    await this.mutate((records) => {
      for (let index = records.length - 1; index >= 0; index -= 1) {
        if (records[index]?.skillId === skillId) records.splice(index, 1)
      }
    })
  }

  /** Read, change and write back under one in-process lock. */
  private async mutate(change: (records: SkillInstallRecord[]) => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      const records = await this.list()
      change(records)
      await this.storage.write(RECORDS_PATH, {
        version: RECORDS_VERSION,
        records
      } satisfies RecordsFile)
    })
    await this.queue
  }
}
