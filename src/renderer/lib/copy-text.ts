import { toast } from 'svelte-sonner'
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

/**
 * Confirm a clipboard action (a copy, a cut) in the default toast.
 *
 * Putting something on the clipboard is a routine acknowledgement, not a status
 * the app reports about its own health, so it must not borrow the success card's
 * green tint: the branded status toasts stay reserved for real outcomes. Every
 * "copied" notice routes through here so the whole app reads in one quiet
 * default card.
 */
export function notifyClipboard(message: string): void {
  toast(message)
}
