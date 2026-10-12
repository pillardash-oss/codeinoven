import { marketSkillName } from '../../lib/skill-market-identity'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  HARNESS_GLOBAL_SKILL_PATHS,
  SHARED_GLOBAL_SKILL_PATH,
  SHARED_PROJECT_SKILL_PATH
} from '../../lib/native-skill-paths'
import { listHarnesses } from '../agents/harness-registry'
import type { StorageEngine } from '../storage/storage-engine'
import type { InstalledSkillLocation } from '../../lib/types'
import { UtilityRegistryService } from './utility-registry-service'
import { SkillInstallRecordStore } from './skill-install-records'

/** One project the scan looks into, reduced to what the scan needs. */
export interface InstalledSkillScanProject {
  id: string
  name: string
  path: string
}

/**
 * Skill folder names inside one skills directory, symlinked folders included.
 * A missing or unreadable directory simply has no skills, which is not an error.
 */
async function skillFolderNames(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

function harnessLabel(harnessId: string): string {
  return listHarnesses().find((harness) => harness.id === harnessId)?.name ?? harnessId
}

/**
 * Every skill CodeInOven itself manages: one entry per registry skill and
 * destination layer. The registry keeps the Skills CLI id in the binding's
 * `transportName`, which is the same id the marketplace uses.
 */
async function registrySkillLocations(
  storage: StorageEngine,
  projectNames: ReadonlyMap<string, string>
): Promise<InstalledSkillLocation[]> {
  const locations: InstalledSkillLocation[] = []
  const utilities = await new UtilityRegistryService(storage).list()
  for (const utility of utilities) {
    if (utility.kind !== 'skill') continue
    for (const binding of utility.harnessBindings) {
      if (binding.strategy !== 'skill' || !binding.transportName) continue
      const shared = {
        skillId: binding.transportName,
        manager: 'cio' as const,
        path: '',
        activation: utility.activation
      }
      if (utility.scope.level === 'global') {
        locations.push({ ...shared, scope: 'global', label: 'All harnesses' })
      } else if (utility.scope.level === 'project') {
        const { projectId } = utility.scope
        locations.push({
          ...shared,
          scope: 'project',
          projectId,
          label: projectNames.get(projectId) ?? projectId
        })
      } else {
        const { projectId, threadId } = utility.scope
        locations.push({
          ...shared,
          scope: 'project',
          projectId,
          label: `${projectNames.get(projectId) ?? projectId} · thread ${threadId}`
        })
      }
    }
  }
  return locations
}

/**
 * Skill folders the native Skills CLI layout holds. Only the directories
 * CodeInOven installs into are scanned (shared global, each harness's global
 * folder, each project's shared folder), so the scan stays a handful of cheap
 * directory reads whatever the machine looks like.
 */
async function nativeSkillLocations(
  projects: readonly InstalledSkillScanProject[]
): Promise<InstalledSkillLocation[]> {
  const home = homedir()
  const locations: InstalledSkillLocation[] = []
  const sharedGlobalDir = join(home, SHARED_GLOBAL_SKILL_PATH.replace(/^~\//u, ''))

  const harnessDirectories = new Map<string, string>()
  for (const [harnessId, displayPath] of Object.entries(HARNESS_GLOBAL_SKILL_PATHS)) {
    const directory = join(home, displayPath.replace(/^~\//u, ''))
    // Cline shares the canonical folder, which is scanned separately.
    if (directory === sharedGlobalDir || !directory.startsWith(home)) continue
    harnessDirectories.set(harnessId, directory)
  }

  const [sharedGlobalNames, harnessSkills, projectSkills] = await Promise.all([
    skillFolderNames(sharedGlobalDir),
    Promise.all(
      [...harnessDirectories].map(async ([harnessId, directory]) => ({
        harnessId,
        directory,
        names: await skillFolderNames(directory)
      }))
    ),
    Promise.all(
      projects.map(async (project) => ({
        project,
        directory: join(project.path, SHARED_PROJECT_SKILL_PATH),
        names: await skillFolderNames(join(project.path, SHARED_PROJECT_SKILL_PATH))
      }))
    )
  ])

  for (const skillId of sharedGlobalNames) {
    locations.push({
      skillId,
      manager: 'native',
      scope: 'global',
      label: 'All harnesses',
      path: sharedGlobalDir
    })
  }
  for (const { harnessId, directory, names } of harnessSkills) {
    for (const skillId of names) {
      locations.push({
        skillId,
        manager: 'native',
        scope: 'harness',
        harnessId,
        label: harnessLabel(harnessId),
        path: directory
      })
    }
  }
  for (const { project, directory, names } of projectSkills) {
    for (const skillId of names) {
      locations.push({
        skillId,
        manager: 'native',
        scope: 'project',
        projectId: project.id,
        label: project.name,
        path: directory
      })
    }
  }
  return locations
}

/**
 * Where each marketplace skill is already installed: CodeInOven-registry copies
 * plus the skill folders the native Skills CLI layout keeps on disk. Read-only
 * and cheap, so the marketplace can refresh it after every install.
 */
export async function listInstalledSkillLocations(
  storage: StorageEngine,
  projects: readonly InstalledSkillScanProject[]
): Promise<InstalledSkillLocation[]> {
  const projectNames = new Map(projects.map((project) => [project.id, project.name]))
  const [registryLocations, nativeLocations, records] = await Promise.all([
    registrySkillLocations(storage, projectNames),
    nativeSkillLocations(projects),
    new SkillInstallRecordStore(storage).list()
  ])
  const locks = new Map<string, Promise<unknown>>()
  const readLock = (path: string): Promise<unknown> => {
    let pending = locks.get(path)
    if (!pending) {
      pending = readFile(path, 'utf-8')
        .then((text): unknown => JSON.parse(text))
        .catch(() => null)
      locks.set(path, pending)
    }
    return pending
  }
  const attributed: InstalledSkillLocation[] = []
  for (const location of [
    ...registryLocations,
    ...nativeLocations.map((location) => ({ ...location, folderName: location.skillId }))
  ]) {
    if (location.manager === 'native') {
      try {
        const marker: unknown = JSON.parse(
          await readFile(join(location.path, location.skillId, '.cio-market.json'), 'utf-8')
        )
        if (
          typeof marker === 'object' &&
          marker !== null &&
          'source' in marker &&
          'skillId' in marker &&
          typeof marker.source === 'string' &&
          typeof marker.skillId === 'string' &&
          marketSkillName(marker.source, marker.skillId) === location.skillId
        ) {
          attributed.push({ ...location, source: marker.source, skillId: marker.skillId })
          continue
        }
      } catch {
        // Legacy folders have no app-owned provenance marker.
      }
    }
    if (location.manager === 'native') {
      const lockPath =
        location.scope === 'project'
          ? join(location.path, '..', '..', 'skills-lock.json')
          : join(homedir(), '.agents', '.skill-lock.json')
      const lock = await readLock(lockPath)
      if (
        typeof lock === 'object' &&
        lock !== null &&
        'skills' in lock &&
        typeof lock.skills === 'object' &&
        lock.skills !== null
      ) {
        const entry: unknown = (lock.skills as Record<string, unknown>)[location.skillId]
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'source' in entry &&
          typeof entry.source === 'string'
        ) {
          const source = entry.source
            .replace(/^https:\/\/github\.com\//u, '')
            .replace(/\.git$/u, '')
          attributed.push({ ...location, source })
          continue
        }
      }
    }
    const candidates = records.filter(
      (record) =>
        record.manager === location.manager &&
        (record.skillId === location.skillId ||
          marketSkillName(record.source, record.skillId) === location.skillId) &&
        (record.scope === location.scope ||
          (record.scope === 'harness' && location.scope === 'global')) &&
        record.projectId === location.projectId &&
        (!location.harnessId ||
          !record.harnessIds?.length ||
          record.harnessIds.includes(location.harnessId))
    )
    const sources = new Set(candidates.map((record) => record.source.toLowerCase()))
    const record = sources.size === 1 ? candidates[0] : undefined
    attributed.push(
      record ? { ...location, skillId: record.skillId, source: record.source } : location
    )
  }
  return attributed
}
