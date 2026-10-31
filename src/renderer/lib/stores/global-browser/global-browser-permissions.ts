import { invoke } from '$lib/ipc.svelte'
import type { BrowserSitePermissionState } from '$shared/ipc-contract'
import { reportError } from '../app-errors.svelte'
import type { GlobalBrowserState } from '../global-browser.svelte'

/** GlobalBrowserState permissions: one concern, moved verbatim from the composition root. */
export class GlobalBrowserStatePermissions {
  constructor(private readonly host: GlobalBrowserState) {}

  /**
   * Set one site permission from the Site Permissions modal.
   *
   * The choice is shown immediately and main is told behind it; main writes the
   * same ledger keys the page-initiated prompt writes and reloads the origin's
   * tabs, so a decision here and a decision in the prompt are the same decision.
   */
  async setSitePermission(permissionId: string, action: BrowserSitePermissionState): Promise<void> {
    const prompt = this.host.sitePermissionsPrompt
    if (!prompt) return
    this.host.sitePermissionsPrompt = {
      ...prompt,
      states: { ...prompt.states, [permissionId]: action }
    }
    try {
      await invoke(
        'browser:setSitePermission',
        prompt.projectId,
        prompt.boxId,
        prompt.origin,
        permissionId,
        action
      )
    } catch (error: unknown) {
      reportError(error, 'The site permission could not be saved.')
    }
  }

  /** Close the Site Permissions modal. */
  dismissSitePermissions(): void {
    this.host.sitePermissionsPrompt = null
  }
}
