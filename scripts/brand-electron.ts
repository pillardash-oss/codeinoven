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

const current = readFileSync(plistPath, 'utf8')
let plist = current
for (const [key, value] of [
  ['CFBundleDisplayName', developmentName],
  ['CFBundleName', developmentName],
  ['CFBundleIdentifier', developmentId],
  ['CFBundleExecutable', developmentName],
  [
    'NSMicrophoneUsageDescription',
    `Record audio for local dictation and transcription in ${developmentName}.`
  ]
]) {
  const entry = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`)
  plist = entry.test(plist)
    ? plist.replace(entry, `$1${value}$2`)
    : plist.replace('</dict>', `\t<key>${key}</key>\n\t<string>${value}</string>\n</dict>`)
}
if (plist !== current) {
  writeFileSync(plistPath, plist, 'utf8')
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
