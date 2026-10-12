import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'

async function copyWithElectron(text: string): Promise<void> {
  await invoke('clipboard:writeText', text)
  const copiedText = await invoke('clipboard:readText')
  if (copiedText !== text) throw new Error('Electron clipboard verification failed')
}

/**
 * Copy text in the desktop renderer and confirm it, in one call.
 *
 * `successMessage` is the confirmation the copy deserves. Leave it out and the
 * copy reads `Copied to clipboard`. Pass `null` when the caller already confirms
 * the copy itself (an inline check on the button, or a panel's own notice), so
 * the app never says the same thing twice.
 *
 * A copy is a routine acknowledgement, not a status the app reports about its
 * own health, so it uses the default toast rather than the green success card.
 *
 * Start both supported paths during the originating user gesture. Electron is
 * verified by reading the value back; the browser fallback keeps copy controls
 * working where desktop IPC is unavailable.
 */
export async function copyText(
  text: string,
  successMessage: string | null = 'Copied to clipboard'
): Promise<void> {
  const attempts: Promise<void>[] = [copyWithElectron(text)]
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    attempts.push(navigator.clipboard.writeText(text))
  }
  try {
    await Promise.any(attempts)
  } catch {
    throw new Error('Clipboard copy failed')
  }
  if (successMessage !== null) toast(successMessage)
}

/**
 * Confirm a clipboard write the main process performed.
 *
 * A copy done in main (a vaulted API key, a dashboard password) never passes
 * through `copyText`, so there is no text to copy here. This is the one case
 * where the confirmation is raised on its own.
 */
export function notifyClipboard(message: string): void {
  toast(message)
}
