/// <reference types="vite/client" />
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from '../../../lib/utils'
import notificationsSource from './compat/cio-bitwarden-notifications.js?raw'

export const BITWARDEN_EXTENSION_ID = 'nngceckbapebfimnlniiiahkandclblb'

const START_MARKER = '/* CIO Bitwarden notification compatibility starts */'
const END_MARKER = '/* CIO Bitwarden notification compatibility ends */'
const NOTIFICATION_BOOTSTRAPS = [
  'content/bootstrap-autofill-overlay-notifications.js',
  'content/bootstrap-autofill-overlay.js'
] as const

/** Refresh only the app-owned Bitwarden copy. The bootstrap still executes its
 * original bytes; the appended shim can reach the service in its isolated world,
 * including the iframe Bitwarden keeps inside a closed shadow root. */
export async function refreshBitwardenNotificationScripts(extensionDir: string): Promise<void> {
  for (const relativePath of NOTIFICATION_BOOTSTRAPS) {
    const path = join(extensionDir, relativePath)
    const contents = await readFile(path, 'utf8').catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
    if (contents === null) continue
    const start = contents.lastIndexOf(START_MARKER)
    const end = contents.lastIndexOf(END_MARKER)
    const original =
      start >= 0 && end > start && contents.slice(end + END_MARKER.length).trim() === ''
        ? contents.slice(0, start)
        : `${contents}\n;\n`
    const next = `${original}${START_MARKER}\n${notificationsSource}\n;\n${END_MARKER}\n`
    if (next !== contents) await atomicWrite(path, next)
  }
}
