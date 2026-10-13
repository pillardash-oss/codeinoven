import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let entryDirectory: string | null = null

/** Dynamic bootstrap chunks must resolve preload/renderer assets from the entry. */
export function setMainBundleDirectory(entryUrl: string): void {
  entryDirectory = dirname(fileURLToPath(entryUrl))
}

export function getMainBundleDirectory(moduleUrl: string): string {
  return entryDirectory ?? dirname(fileURLToPath(moduleUrl))
}
