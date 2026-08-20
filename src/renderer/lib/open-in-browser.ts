import { invoke } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { isLocalDevelopmentUrl } from '$shared/local-development-url'

export async function openInBrowser(url: string): Promise<void> {
  if (appConfigState.openLocalhostInCioBrowser && isLocalDevelopmentUrl(url)) {
    contextSidebarState.openBrowser(url)
    return
  }
  await invoke('shell:openExternal', url)
}
