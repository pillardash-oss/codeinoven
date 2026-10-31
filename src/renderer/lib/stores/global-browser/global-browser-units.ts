import type { GlobalBrowserState } from '../global-browser.svelte'
import { GlobalBrowserStateQueries } from './global-browser-queries'
import { GlobalBrowserStatePermissions } from './global-browser-permissions'
import { GlobalBrowserStateRuntime } from './global-browser-runtime'
import { GlobalBrowserStateLifecycle } from './global-browser-lifecycle'
import { GlobalBrowserStateInstallation } from './global-browser-installation'
import { GlobalBrowserStatePanels } from './global-browser-panels'
import { GlobalBrowserStateCommands } from './global-browser-commands'
import { GlobalBrowserStateStorage } from './global-browser-storage'

/** The concern units a GlobalBrowserState delegates to, built once in its constructor. */
export function buildGlobalBrowserStateUnits(engine: GlobalBrowserState) {
  return {
    queries: new GlobalBrowserStateQueries(engine),
    permissions: new GlobalBrowserStatePermissions(engine),
    runtime: new GlobalBrowserStateRuntime(engine),
    lifecycle: new GlobalBrowserStateLifecycle(engine),
    installation: new GlobalBrowserStateInstallation(engine),
    panels: new GlobalBrowserStatePanels(engine),
    commands: new GlobalBrowserStateCommands(engine),
    storage: new GlobalBrowserStateStorage(engine)
  } as const
}

export type GlobalBrowserStateUnits = ReturnType<typeof buildGlobalBrowserStateUnits>
