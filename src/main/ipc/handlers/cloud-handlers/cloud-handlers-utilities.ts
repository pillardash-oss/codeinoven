import { app } from 'electron'
import { APP_NAME } from '../../../../lib/brand'
import { listInstalledSkillLocations } from '../../../utilities/installed-skill-locations'
import { uninstallMarketSkill } from '../../../utilities/skill-uninstall'
import {
  installMarketSkill,
  isGithubSkillSource,
  isWellKnownSkillSource,
  type MarketSkillInstallContext
} from '../../../utilities/skill-install'
import {
  embeddedLeaderboard,
  fetchSkillMarketPage,
  loadSkillMarketDetail,
  publicMarketEntry
} from '../../../utilities/skill-market'
import { idleSkillUpdateStatus } from '../../../utilities/skill-updates'
import { validateBoundedString, validateEntityId } from '../../ipc-validation'
import { isRecord } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import type { IpcHandlerContext } from '../context'

const SKILL_MARKET_VIEWS = new Set(['all-time', 'trending', 'hot'])

function selectedIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new TypeError(`${label} must contain between 1 and 50 selections`)
  }
  return [...new Set(value.map((item) => validateEntityId(item, label.replace(/s$/u, ''), 256)))]
}

/** Resolve the native drag icon. Prefer the dragged file's own Finder icon so
 *  the drag ghost keeps the file's look; fall back to the app icon. */

/** Skill marketplace search, detail, install and update surfaces. */
export function registerUtilityHandlers(ctx: IpcHandlerContext): void {
  const {
    storage,
    projectManager,
    githubAuthService,
    skillUpdates,
    utilityFootprint,
    resolveProjectPath
  } = ctx

  ipcMain.handle('utilities:searchSkillMarket', async (_, rawQuery: unknown) => {
    const query = validateBoundedString(rawQuery, 'Skill search query', 2, 200)
    const url = new URL('https://www.skills.sh/api/search')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '50')
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': `${APP_NAME}/desktop` },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`Skills market search failed (${response.status})`)
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload['skills'])) {
      throw new Error('Skills market returned an invalid response')
    }
    const entries = payload['skills'].flatMap((rawEntry) => {
      if (!isRecord(rawEntry)) return []
      const id = rawEntry['id']
      const skillId = rawEntry['skillId']
      const name = rawEntry['name']
      const source = rawEntry['source']
      const installs = rawEntry['installs']
      if (
        typeof id !== 'string' ||
        typeof skillId !== 'string' ||
        typeof name !== 'string' ||
        typeof source !== 'string' ||
        typeof installs !== 'number'
      ) {
        return []
      }
      return [
        {
          id,
          skillId,
          name,
          source,
          installs,
          url: `https://www.skills.sh/${id}`
        }
      ]
    })
    return { query, entries }
  })

  ipcMain.handle('utilities:listSkillMarket', async (_, rawView: unknown) => {
    if (typeof rawView !== 'string' || !SKILL_MARKET_VIEWS.has(rawView)) {
      throw new TypeError('Skill market view is invalid')
    }
    const pathname = rawView === 'all-time' ? '/' : `/${rawView}`
    const entries = embeddedLeaderboard(await fetchSkillMarketPage(pathname))
      .slice(0, 100)
      .map(publicMarketEntry)
    return { view: rawView as 'all-time' | 'trending' | 'hot', entries }
  })

  ipcMain.handle('utilities:getSkillMarketDetail', (_, rawId: unknown) =>
    loadSkillMarketDetail(rawId)
  )

  ipcMain.handle('utilities:installMarketSkill', async (_, rawRequest: unknown) => {
    if (!isRecord(rawRequest)) throw new TypeError('Skill install request must be an object')
    const source = validateBoundedString(rawRequest['source'], 'Skill source', 3, 300)
    const skillId = validateEntityId(rawRequest['skillId'], 'Skill ID', 200)
    if (!isGithubSkillSource(source) && !isWellKnownSkillSource(source)) {
      throw new TypeError('Skill source is invalid')
    }
    const manager = rawRequest['manager']
    if (manager !== 'cio' && manager !== 'native') {
      throw new TypeError('Select who should manage this skill')
    }
    const scope = rawRequest['scope']
    if (!isRecord(scope)) throw new TypeError('Skill install scope must be an object')
    const scopeKind = scope['kind']
    if (scopeKind !== 'global' && scopeKind !== 'projects' && scopeKind !== 'harnesses') {
      throw new TypeError('Select global, project, or harness installation')
    }
    // Who owns the copy and where it goes is the whole request: a skill is
    // never standing context, so it has no activation to choose.
    // One install assistant serves the card and the background updater, so both
    // put the skill in exactly the destination the card advertises.
    return installMarketSkill(skillInstallContext(), {
      source,
      skillId,
      manager,
      scope: scopeKind,
      projectIds: scopeKind === 'projects' ? selectedIds(scope['projectIds'], 'Project IDs') : [],
      harnessIds: scopeKind === 'harnesses' ? selectedIds(scope['harnessIds'], 'Harness IDs') : []
    })
  })

  /** Everything one marketplace install needs, wherever it is triggered from. */
  const skillInstallContext = (): MarketSkillInstallContext => ({
    storage,
    home: app.getPath('home'),
    resolveProjectPath,
    githubToken: () => githubAuthService.resolveToken(),
    // A CodeInOven-managed copy is a registry entry, so a project-scoped one is
    // installed into that project's own `.cio` folder by the same service the
    // Utilities page uses.
    ...(utilityFootprint ? { footprint: utilityFootprint } : {})
  })

  /** Projects a native skill scan can look into: local ones with a real path. */
  const skillScanProjects = async (): Promise<Array<{ id: string; name: string; path: string }>> =>
    (await projectManager.listProjects())
      .filter((project) => project.source !== 'ssh' && Boolean(project.path))
      .map((project) => ({ id: project.id, name: project.name, path: project.path }))

  ipcMain.handle('utilities:installedSkillLocations', async () =>
    listInstalledSkillLocations(storage, await skillScanProjects())
  )

  ipcMain.handle('utilities:uninstallMarketSkill', async (_, rawSkillId: unknown) => {
    const marketId = validateBoundedString(rawSkillId, 'Skill market ID', 3, 500)
    const segments = marketId.split('/')
    const skillId = validateEntityId(segments.pop(), 'Skill ID', 200)
    const source = segments.join('/')
    if (!isGithubSkillSource(source) && !isWellKnownSkillSource(source)) {
      throw new TypeError('Skill source is invalid')
    }
    return uninstallMarketSkill(
      storage,
      skillId,
      source,
      await skillScanProjects(),
      app.getPath('home'),
      utilityFootprint
    )
  })

  // Background skill updates ride the app-update check cycle, so this layer only
  // reads the current state and offers an explicit pass on demand.
  ipcMain.handle('utilities:skillUpdateStatus', async () =>
    skillUpdates ? await skillUpdates.status() : idleSkillUpdateStatus()
  )

  ipcMain.handle('utilities:checkSkillUpdates', async () => {
    if (!skillUpdates) throw new Error('Skill updates are unavailable in this session')
    return skillUpdates.checkNow()
  })
}
