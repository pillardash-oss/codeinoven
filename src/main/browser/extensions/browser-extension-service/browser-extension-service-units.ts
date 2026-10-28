import type { BrowserExtensionService } from '../browser-extension-service'
import { BrowserExtensionServiceQueries } from './browser-extension-service-queries'
import { BrowserExtensionServiceRuntime } from './browser-extension-service-runtime'
import { BrowserExtensionServicePanels } from './browser-extension-service-panels'
import { BrowserExtensionServiceInstallation } from './browser-extension-service-installation'
import { BrowserExtensionServiceLifecycle } from './browser-extension-service-lifecycle'
import { BrowserExtensionServiceCommands } from './browser-extension-service-commands'
import { BrowserExtensionServiceStorage } from './browser-extension-service-storage'
import { BrowserExtensionServiceMessaging } from './browser-extension-service-messaging'
import { BrowserExtensionServicePermissions } from './browser-extension-service-permissions'

/** The concern units a BrowserExtensionService delegates to, built once in its constructor. */
export function buildBrowserExtensionServiceUnits(engine: BrowserExtensionService) {
  return {
    queries: new BrowserExtensionServiceQueries(engine),
    runtime: new BrowserExtensionServiceRuntime(engine),
    panels: new BrowserExtensionServicePanels(engine),
    installation: new BrowserExtensionServiceInstallation(engine),
    lifecycle: new BrowserExtensionServiceLifecycle(engine),
    commands: new BrowserExtensionServiceCommands(engine),
    storage: new BrowserExtensionServiceStorage(engine),
    messaging: new BrowserExtensionServiceMessaging(engine),
    permissions: new BrowserExtensionServicePermissions(engine)
  } as const
}

export type BrowserExtensionServiceUnits = ReturnType<typeof buildBrowserExtensionServiceUnits>
