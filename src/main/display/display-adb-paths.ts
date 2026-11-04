/** The adb binary and nothing else.
 *
 * Discovery, presence and capture all need the same answer to "where is adb", and
 * only capture needs Electron's image APIs. Keeping the lookup in its own
 * node-only module is what lets the presence watch ask the devices a question
 * without loading a single capture adapter.
 */
import { accessSync, constants as fsConstants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Where an adb binary hides on a machine that has Android tooling installed. */
function adbCandidates(): string[] {
  const candidates: string[] = []
  const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT
  if (androidHome) candidates.push(join(androidHome, 'platform-tools', 'adb'))
  const home = homedir()
  candidates.push(
    join(home, 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
    join(home, 'Android', 'Sdk', 'platform-tools', 'adb'),
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    '/usr/bin/adb'
  )
  return candidates
}

/** The binary already found, if one has been. Only a success is remembered: a
 *  machine that gains platform-tools while the app runs should find it on the
 *  next listing instead of needing a restart. */
let resolvedAdb: string | null = null

/** The adb binary this machine has, resolved once and reused after that. */
export function resolveAdb(): string | null {
  if (resolvedAdb) return resolvedAdb
  for (const candidate of adbCandidates()) {
    try {
      accessSync(candidate, fsConstants.X_OK)
      resolvedAdb = candidate
      return resolvedAdb
    } catch {
      // Next candidate: a machine can have several SDKs, and only one needs to work.
    }
  }
  return null
}
