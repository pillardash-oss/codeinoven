import type { SkillUninstallReport } from '../../lib/types'
import type { InstalledSkillScanProject } from './installed-skill-locations'
import { listInstalledSkillLocations } from './installed-skill-locations'
import { SkillInstallRecordStore } from './skill-install-records'
import { runSkillsCli } from './skills-cli'
import type { StorageEngine } from '../storage/storage-engine'
import { UtilityRegistryService } from './utility-registry-service'

/**
 * Removes one marketplace skill from every place it was installed: all
 * CodeInOven registry entries that manage it, however they were scoped, and
 * every native copy on disk.
 *
 * Native copies are handed to the Skills CLI, which owns that layout: a global
 * run also drops the agent links and folders the CLI keeps for the other
 * harnesses, so an uninstall leaves nothing behind to be discovered later. A
 * project run is repeated in each project that still holds a copy.
 *
 * The install records go too: nothing left to keep fresh, and a later re-install
 * starts from a clean baseline.
 */
export async function uninstallMarketSkill(
  storage: StorageEngine,
  skillId: string,
  projects: readonly InstalledSkillScanProject[],
  home: string
): Promise<SkillUninstallReport> {
  const registry = new UtilityRegistryService(storage)
  let registryEntries = 0
  for (const utility of await registry.list()) {
    if (utility.kind !== 'skill') continue
    const managesSkill = utility.harnessBindings.some(
      (binding) => binding.strategy === 'skill' && binding.transportName === skillId
    )
    if (managesSkill && (await registry.delete(utility.id))) registryEntries += 1
  }

  const nativeLocations = (await listInstalledSkillLocations(storage, projects)).filter(
    (location) => location.manager === 'native' && location.skillId === skillId
  )
  let nativeScopes = 0
  if (nativeLocations.some((location) => location.scope !== 'project')) {
    await runSkillsCli(['remove', skillId, '--global', '--yes'], home)
    nativeScopes += 1
  }
  const projectIds = new Set(
    nativeLocations
      .filter((location) => location.scope === 'project')
      .map((location) => location.projectId)
  )
  for (const projectId of projectIds) {
    const project = projects.find((candidate) => candidate.id === projectId)
    if (!project) continue
    await runSkillsCli(['remove', skillId, '--yes'], project.path)
    nativeScopes += 1
  }

  await new SkillInstallRecordStore(storage).removeSkill(skillId)

  return { registryEntries, nativeScopes }
}
