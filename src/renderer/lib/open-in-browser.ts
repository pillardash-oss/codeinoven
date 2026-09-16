import { invoke } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { isLocalDevelopmentUrl } from '$shared/local-development-url'

export async function openInBrowser(url: string): Promise<void> {
  // `openBrowser` returns null when no project thread is active to own the
  // tab, in which case the operating-system browser is the usable fallback
  // instead of a silent no-op.
  if (
    appConfigState.openLocalhostInCioBrowser &&
    isLocalDevelopmentUrl(url) &&
    contextSidebarState.openBrowser(url) !== null
  ) {
    return
  }
  await invoke('shell:openExternal', url)
}
