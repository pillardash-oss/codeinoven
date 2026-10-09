import type { SkillUninstallReport } from '../../lib/types'
import type { InstalledSkillScanProject } from './installed-skill-locations'
import { listInstalledSkillLocations } from './installed-skill-locations'
import { SkillInstallRecordStore } from './skill-install-records'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { marketSkillName } from '../../lib/skill-market-identity'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import type { UtilityScopeFootprintService } from './utility-scope-footprint'
import { UtilityRegistryService } from './utility-registry-service'

/** Remove only registry entries and native folders attributed to this publisher. */
export async function uninstallMarketSkill(
  storage: StorageEngine,
  skillId: string,
  source: string,
  projects: readonly InstalledSkillScanProject[],
  _home: string,
  footprint?: UtilityScopeFootprintService
): Promise<SkillUninstallReport> {
  const locations = (await listInstalledSkillLocations(storage, projects)).filter(
    (location) =>
      location.skillId === skillId && location.source?.toLowerCase() === source.toLowerCase()
  )
  const installName = marketSkillName(source, skillId)
  const registry = new UtilityRegistryService(storage)
  let registryEntries = 0
  for (const utility of await registry.list()) {
    if (utility.kind !== 'skill') continue
    const managesSkill = utility.harnessBindings.some(
      (binding) =>
        binding.strategy === 'skill' &&
        (binding.transportName === installName ||
          (binding.transportName === skillId &&
            locations.some(
              (location) =>
                location.manager === 'cio' &&
                location.scope === utility.scope.level &&
                location.projectId ===
                  ('projectId' in utility.scope ? utility.scope.projectId : undefined)
            )))
    )
    if (managesSkill && (await registry.delete(utility.id))) registryEntries += 1
  }
  if (registryEntries > 0 && footprint) {
    await footprint
      .reconcile(await registry.list())
      .catch((error: unknown) => Logger.dev('Uninstalled skill folders were not removed:', error))
  }

  const nativeLocations = locations.filter((location) => location.manager === 'native')
  let nativeScopes = 0
  for (const location of nativeLocations) {
    // Delete only the attributed folder. A short-name CLI removal also removes
    // other harness copies, which can belong to a different publisher.
    await rm(join(location.path, location.folderName ?? skillId), { recursive: true, force: true })
    nativeScopes += 1
  }
  await new SkillInstallRecordStore(storage).removeSkill(skillId, source)

  return { registryEntries, nativeScopes }
}
