import { AgentPluginService } from '../../../utilities/agent-plugins'
import { validateBoolean, validateBoundedString } from '../../ipc-validation'
import { isRecord } from '../shared'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import type { IpcHandlerContext } from '../context'

/** Plugin marketplace browsing, install and update, delegated to the service. */
export function registerPluginHandlers(ctx: IpcHandlerContext): void {
  const agentPlugins = new AgentPluginService(ctx.storage)

  ipcMain.handle('plugins:listMarketplaces', () => agentPlugins.listMarketplaces())
  ipcMain.handle('plugins:addMarketplace', (_, rawRequest: unknown) => {
    if (!isRecord(rawRequest)) throw new TypeError('Marketplace request must be an object')
    const platform = rawRequest['platform']
    if (platform !== 'codex' && platform !== 'claude')
      throw new TypeError('Plugin platform is invalid')
    return agentPlugins.addMarketplace({
      url: validateBoundedString(rawRequest['url'], 'Marketplace URL', 3, 2_000),
      platform
    })
  })
  ipcMain.handle('plugins:removeMarketplace', (_, rawId: unknown) =>
    agentPlugins.removeMarketplace(validateBoundedString(rawId, 'Marketplace ID', 1, 300))
  )
  ipcMain.handle(
    'plugins:list',
    (_, rawQuery: unknown, rawOffset: unknown, rawLimit: unknown, rawView: unknown) => {
      const query =
        rawQuery === undefined ? '' : validateBoundedString(rawQuery, 'Plugin search', 0, 200)
      const offset = rawOffset === undefined ? 0 : rawOffset
      const limit = rawLimit === undefined ? 40 : rawLimit
      const view = rawView === undefined ? 'discover' : rawView
      if (
        typeof offset !== 'number' ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 100_000
      ) {
        throw new TypeError('Plugin result offset is invalid')
      }
      if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 60) {
        throw new TypeError('Plugin result limit is invalid')
      }
      if (view !== 'discover' && view !== 'bookmarks' && view !== 'installed') {
        throw new TypeError('Plugin marketplace view is invalid')
      }
      return agentPlugins.listEntries(query, offset, limit, view)
    }
  )
  ipcMain.handle('plugins:getIcon', (_, rawId: unknown) =>
    agentPlugins.getIcon(validateBoundedString(rawId, 'Plugin ID', 1, 300))
  )
  ipcMain.handle('plugins:getDetail', (_, rawId: unknown) =>
    agentPlugins.getDetail(validateBoundedString(rawId, 'Plugin ID', 1, 300))
  )
  ipcMain.handle('plugins:setBookmarked', (_, rawId: unknown, rawBookmarked: unknown) =>
    agentPlugins.setBookmarked(
      validateBoundedString(rawId, 'Plugin ID', 1, 300),
      validateBoolean(rawBookmarked, 'Bookmarked')
    )
  )
  ipcMain.handle('plugins:listInstalled', () => agentPlugins.listInstalled())
  ipcMain.handle('plugins:install', (_, rawId: unknown) =>
    agentPlugins.install(validateBoundedString(rawId, 'Plugin ID', 1, 300))
  )
  ipcMain.handle('plugins:update', (_, rawId: unknown) =>
    agentPlugins.update(validateBoundedString(rawId, 'Plugin ID', 1, 300))
  )
  ipcMain.handle('plugins:uninstall', (_, rawId: unknown) =>
    agentPlugins.uninstall(validateBoundedString(rawId, 'Plugin ID', 1, 300))
  )
}
