import { readdir } from 'node:fs/promises'
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
  const [registryLocations, nativeLocations] = await Promise.all([
    registrySkillLocations(storage, projectNames),
    nativeSkillLocations(projects)
  ])
  return [...registryLocations, ...nativeLocations]
}
