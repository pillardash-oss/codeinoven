/**
 * Brand the dev-mode Electron bundle with the product name (macOS only).
 *
 * `electron-vite dev` launches the raw Electron.app binary from node_modules,
 * so the menu bar and Dock display "Electron" unless the bundle is patched.
 * This script rewrites CFBundleDisplayName / CFBundleName in Info.plist and
 * swaps the bundle icon, then re-signs the modified bundle so the dev
 * experience matches the packaged app. Electron 42+ requires a real Apple
 * signing identity for reliable UNNotification delivery; an ad-hoc signature
 * only keeps the modified bundle launchable.
 * Runs via `postinstall` and `predev` hooks; exits instantly when the bundle
 * is already branded and its icon is current.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
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

const current = readFileSync(plistPath, 'utf8')
const alreadyBranded =
  new RegExp(`<key>CFBundleName</key>\\s*<string>${APP_NAME}</string>`).test(current) &&
  new RegExp(`<key>CFBundleIdentifier</key>\\s*<string>${APP_ID}</string>`).test(current)
let resourcesChanged = false

function availableAppleSigningIdentity(): string | null {
  const configuredIdentity = process.env['CSC_NAME']?.trim()
  if (configuredIdentity) return configuredIdentity

  try {
    const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8'
    })
    const identities = [...output.matchAll(/"([^"]+)"/g)].flatMap((match) =>
      match[1] ? [match[1]] : []
    )
    return (
      identities.find((identity) => identity?.startsWith('Developer ID Application:')) ??
      identities.find((identity) => identity?.startsWith('Apple Development:')) ??
      null
    )
  } catch {
    return null
  }
}

function currentSigningDetails(): string {
  const result = spawnSync('codesign', ['--display', '--verbose=4', appBundle], {
    encoding: 'utf8'
  })
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`
}

if (!alreadyBranded) {
  // Patch the display name and bundle name. CFBundleExecutable must remain
  // "Electron" because it has to match the actual binary filename.
  let plist = current
  for (const [key, value] of [
    ['CFBundleDisplayName', APP_NAME],
    ['CFBundleName', APP_NAME],
    ['CFBundleIdentifier', APP_ID]
  ]) {
    plist = plist.replace(
      new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`),
      `$1${value}$2`
    )
  }
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

// Electron 42+ uses macOS UNNotification. A merely valid ad-hoc signature is
// enough to launch a modified bundle but is not a reliable notification
// identity. Prefer an installed Apple identity and upgrade an existing ad-hoc
// signature even when `codesign --verify` succeeds.
const signingIdentity = availableAppleSigningIdentity()
const signingDetails = currentSigningDetails()
const hasRequestedIdentity =
  signingIdentity !== null && signingDetails.includes(`Authority=${signingIdentity}`)

function hasValidSignature(): boolean {
  try {
    execFileSync('codesign', ['--verify', '--deep', '--strict', appBundle], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const signatureValid = hasValidSignature()
if (resourcesChanged || !signatureValid || (signingIdentity !== null && !hasRequestedIdentity)) {
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', signingIdentity ?? '-', appBundle], {
      stdio: 'ignore'
    })
  } catch (error) {
    Logger.error('[brand-electron] Dev bundle could not be signed:', error)
  }
}

if (signingIdentity === null) {
  Logger.dev(
    '[brand-electron] No Apple signing identity found; macOS development notifications may be rejected.'
  )
}

Logger.dev(`[brand-electron] Dev bundle prepared as ${APP_NAME}.`)
