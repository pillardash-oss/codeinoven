import { IDLE_GLOBAL_BROWSER_RUNTIME, type GlobalBrowserRuntime } from '../global-browser-types'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState commands: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStateCommands {
  constructor(private readonly host: GlobalBrowserState) {}

  /** Live runtime of one tab, or the shared idle value while main has reported
   *  nothing for it. */
  runtimeFor(tabId: string): GlobalBrowserRuntime {
    return this.host.runtime.get(tabId) ?? IDLE_GLOBAL_BROWSER_RUNTIME
  }
}
