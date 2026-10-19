import { app } from 'electron'
import { join } from 'node:path'
import { isUnpackagedElectronLaunch } from '../../lib/utils'

/**
 * Root of the `resources/` tree this launch ships: the packaged Resources
 * directory for a shipped build, the checkout's `resources/` for a development
 * launch.
 *
 * `app.isPackaged` alone cannot answer this. Electron decides it from the
 * executable it actually resolved, so a development bundle whose
 * `Contents/MacOS/Electron` is a symlink or a product-named copy (both left
 * behind by an older branding pass) reports `isPackaged === true` while
 * `process.resourcesPath` still points at the Electron download inside
 * `node_modules`, where none of this app's resources live. A launch that was
 * handed the app path is a development launch whatever the bundle claims, so it
 * always resolves from the checkout and never lands in the Electron download.
 */
export function appResourcesRoot(): string {
  return appShipsPackagedResources() ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

/**
 * Whether this launch reads its bundled resources from a packaged Resources
 * directory rather than from the checkout's `resources/` tree.
 */
export function appShipsPackagedResources(): boolean {
  return app.isPackaged && !isUnpackagedElectronLaunch()
}
