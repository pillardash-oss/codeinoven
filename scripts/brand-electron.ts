/**
 * Brand the dev-mode Electron bundle with the product name (macOS only).
 *
 * `electron-vite dev` launches the raw Electron.app binary from node_modules,
 * so the menu bar and Dock display "Electron" unless the bundle is patched.
 * This script rewrites CFBundleDisplayName / CFBundleName in Info.plist and
 * swaps the bundle icon, then re-signs the modified bundle so the dev
 * experience matches the packaged app.
 * Runs via the `predev` hook; only changes bundle resources when necessary.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID, APP_NAME } from '../src/lib/brand'
import { Logger } from '../src/main/system/logger'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  process.exit(0)
}

const appBundle = join(root, 'node_modules/electron/dist/Electron.app')
const plistPath = join(appBundle, 'Contents/Info.plist')
const iconTarget = join(appBundle, 'Contents/Resources/electron.icns')
const iconSource = join(root, 'src/renderer/static/macos/AppIcon.icns')

if (!existsSync(plistPath)) {
  Logger.dev('[brand-electron] Electron.app not found — skipping.')
  process.exit(0)
}

// Keep Electron's conventional entry path available for packagers, while dev
// launches use the product executable so macOS attributes capture correctly.
const executableDirectory = join(appBundle, 'Contents/MacOS')
const brandedExecutable = join(executableDirectory, APP_NAME)
const originalExecutable = join(executableDirectory, 'Electron')
let resourcesChanged = false
if (!existsSync(brandedExecutable)) {
  copyFileSync(originalExecutable, brandedExecutable)
  resourcesChanged = true
}
writeFileSync(
  join(root, 'node_modules/electron/path.txt'),
  `Electron.app/Contents/MacOS/${APP_NAME}`
)

const current = readFileSync(plistPath, 'utf8')
let plist = current
for (const [key, value] of [
  ['CFBundleDisplayName', APP_NAME],
  ['CFBundleName', APP_NAME],
  ['CFBundleIdentifier', APP_ID],
  ['CFBundleExecutable', APP_NAME],
  [
    'NSMicrophoneUsageDescription',
    `Record audio for local dictation and transcription in ${APP_NAME}.`
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

// Keep the bundle icon synchronized even when the app identity was branded by
// an earlier run.
if (existsSync(iconSource)) {
  const iconIsCurrent =
    existsSync(iconTarget) && readFileSync(iconSource).equals(readFileSync(iconTarget))

  if (!iconIsCurrent) {
    copyFileSync(iconSource, iconTarget)
    resourcesChanged = true
  }
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

Logger.dev(`[brand-electron] Dev bundle prepared as ${APP_NAME}.`)
