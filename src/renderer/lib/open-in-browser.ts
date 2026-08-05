import { invoke } from '$lib/ipc.svelte'

export async function openInBrowser(url: string): Promise<void> {
  await invoke('shell:openExternal', url)
}
