/**
 * Keep the macOS development runtime named Electron, independently of production
 * branding. Repair bundles prepared by older CodeInOven branding scripts and
 * re-sign changed resources so native OS integrations keep working.
 */
import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Logger } from '../src/main/system/logger'
import { APP_NAME } from '../src/lib/brand'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const appBundle = join(root, 'node_modules/electron/dist/Electron.app')
const plistPath = join(appBundle, 'Contents/Info.plist')
const developmentName = 'Electron'
const developmentId = 'com.github.Electron'

if (!existsSync(plistPath)) {
  Logger.dev('[brand-electron] Electron.app not found — skipping.')
  process.exit(0)
}

// Restore the standard launch path even if an earlier preparation selected
// CodeInOven. Electron decides `app.isPackaged` from the executable it actually
// resolved, so a symlink (or any path resolving outside this file) makes a
// development launch report itself as packaged while `process.resourcesPath`
// still points at this Electron download, and every bundled resource then
// resolves into a directory that does not exist (`resources/speech/...`). A real
// file at the conventional path is what keeps a dev launch reported as
// unpackaged, so a link is replaced instead of trusted.
const executableDirectory = join(appBundle, 'Contents/MacOS')
const originalExecutable = join(executableDirectory, developmentName)
const productExecutable = join(executableDirectory, APP_NAME)
let resourcesChanged = false
const executableIsRealFile =
  existsSync(originalExecutable) && !lstatSync(originalExecutable).isSymbolicLink()
if (!executableIsRealFile && existsSync(productExecutable)) {
  rmSync(originalExecutable, { force: true })
  copyFileSync(productExecutable, originalExecutable)
  resourcesChanged = true
  Logger.dev('[brand-electron] Replaced a non-Electron entry point with a real executable.')
} else if (!executableIsRealFile) {
  Logger.error(
    '[brand-electron] The dev executable is not Electron itself and no product executable can restore it; bundled resources will not resolve.'
  )
}
const pathTxt = join(root, 'node_modules/electron/path.txt')
const developmentPath = 'Electron.app/Contents/MacOS/Electron'
if (!existsSync(pathTxt) || readFileSync(pathTxt, 'utf8').trim() !== developmentPath) {
  writeFileSync(pathTxt, developmentPath)
}

/**
 * Read the bundle's Info.plist as a plain object through `plutil`.
 *
 * Editing the XML text is the obvious way to write this, and it is the way that
 * once dropped `NSLocalNetworkUsageDescription` into a nested asar integrity
 * dictionary instead of the top level. The bundle then carried the key and macOS
 * still refused the app every local network connection, which is indistinguishable
 * from an Oven that is switched off. Converting through `plutil` edits the real
 * top-level dictionary, so a key cannot land somewhere the system never reads.
 */
function readPlistObject(path: string): Record<string, unknown> {
  const json = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], {
    encoding: 'utf8'
  })
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new TypeError('The dev bundle Info.plist did not parse into a dictionary.')
  return parsed as Record<string, unknown>
}

/**
 * Compare two plist dictionaries by value.
 *
 * A raw `JSON.stringify` comparison is order-sensitive while a plist is not: an
 * object that a previous pass already wrote correctly comes back from `plutil`
 * with its keys in a different order, so a string comparison reports a change
 * that does not exist, rewrites the file with identical bytes, and then fails
 * its own "did the write land" guard because the text never differed.
 */
function plistValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((entry, index) => plistValuesEqual(entry, right[index]))
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) return false
  return leftKeys.every(
    (key) =>
      Object.hasOwn(rightRecord, key) && plistValuesEqual(leftRecord[key], rightRecord[key])
  )
}

/** Remove one key everywhere it appears, including any copy left nested. */
function removeKeyEverywhere(value: unknown, key: string): void {
  if (Array.isArray(value)) {
    for (const entry of value) removeKeyEverywhere(entry, key)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  delete record[key]
  for (const nested of Object.values(record)) removeKeyEverywhere(nested, key)
}

const managedKeys: [string, string][] = [
  ['CFBundleDisplayName', developmentName],
  ['CFBundleName', developmentName],
  ['CFBundleIdentifier', developmentId],
  ['CFBundleExecutable', developmentName],
  [
    'NSMicrophoneUsageDescription',
    `Record audio for local dictation and transcription in ${developmentName}.`
  ],
  // macOS 15 and later deny every local-network connection from an app that
  // carries no local-network description, and a development run that cannot
  // reach a Wi-Fi tablet or a local virtual machine looks exactly like an Oven
  // that is down. A packaged build gets the same key from electron-builder.yml.
  [
    'NSLocalNetworkUsageDescription',
    `${developmentName} connects to the Ovens you add, such as a tablet on your Wi-Fi or a virtual machine on this Mac, over SSH.`
  ]
]
const before = readPlistObject(plistPath)
const after: Record<string, unknown> = JSON.parse(JSON.stringify(before)) as Record<string, unknown>
for (const [key, value] of managedKeys) {
  // A key left nested by an older branding pass is removed first, so exactly one
  // copy remains and it is the one the system reads.
  removeKeyEverywhere(after, key)
  after[key] = value
}
if (!plistValuesEqual(after, before)) {
  const converted = join(dirname(plistPath), 'Info.plist.converted')
  writeFileSync(converted, JSON.stringify(after), 'utf8')
  try {
    execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', plistPath, converted])
  } finally {
    rmSync(converted, { force: true })
  }
  if (!plistValuesEqual(readPlistObject(plistPath), after))
    throw new Error('Info.plist was not updated.')
  resourcesChanged = true
}

// Invalidate the Launch Services cache when branding changes so macOS picks up
// the new identity.
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
if (resourcesChanged) {
  try {
    execFileSync('touch', [appBundle])
    execFileSync(lsregister, ['-f', appBundle])
  } catch {
    // Non-fatal: worst case the old name lingers until the cache refreshes.
  }
}

// Electron 42+ uses macOS UNNotification, which rejects unsigned apps.
// Re-sign after changing bundle resources so development notifications work.
try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'ignore' })
} catch {
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appBundle], {
      stdio: 'ignore'
    })
  } catch (error) {
    Logger.error('[brand-electron] Dev bundle could not be signed:', error)
  }
}

Logger.dev(`[brand-electron] Dev bundle prepared as ${developmentName}.`)
