import { app } from 'electron'
import { join } from 'node:path'
import { isUnpackagedElectronLaunch } from '../../lib/utils'

/**
 * Whether this launch is a shipped build: one Electron runs from its own
 * installed bundle, as opposed to a development launch out of a checkout.
 *
 * `app.isPackaged` alone cannot answer this, and anything that trusts it alone
 * ends up acting on an installed build in development. Electron decides it from
 * the executable it actually resolved, so a development bundle whose
 * `Contents/MacOS/Electron` is a symlink or a product-named copy (both left
 * behind by an earlier branding pass) reports `isPackaged === true` while
 * `process.resourcesPath` still points at the Electron download inside
 * `node_modules`, where none of this app's resources or install metadata live.
 * A launch that was handed the app path is a development launch whatever the
 * bundle claims, so that is the signal this helper trusts.
 */
export function isShippedBuild(): boolean {
  return app.isPackaged && !isUnpackagedElectronLaunch()
}

/**
 * Root of the `resources/` tree this launch ships: the packaged Resources
 * directory for a shipped build, the checkout's `resources/` for a development
 * launch. One authority, so a misbranded dev runtime can never send a bundled
 * resource lookup into the Electron download.
 */
export function appResourcesRoot(): string {
  return isShippedBuild() ? process.resourcesPath : join(app.getAppPath(), 'resources')
}
