import { invoke } from '$lib/ipc.svelte'

async function copyWithElectron(text: string): Promise<void> {
  await invoke('clipboard:writeText', text)
  const copiedText = await invoke('clipboard:readText')
  if (copiedText !== text) throw new Error('Electron clipboard verification failed')
}

/**
 * Copy text in the desktop renderer.
 *
 * Start both supported paths during the originating user gesture. Electron is
 * verified by reading the value back; the browser fallback keeps copy controls
 * working where desktop IPC is unavailable.
 */
export async function copyText(text: string): Promise<void> {
  const attempts: Promise<void>[] = [copyWithElectron(text)]
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    attempts.push(navigator.clipboard.writeText(text))
  }
  try {
    await Promise.any(attempts)
  } catch {
    throw new Error('Clipboard copy failed')
  }
}
