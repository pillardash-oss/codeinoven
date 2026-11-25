import { sign as signAsync } from '@electron/osx-sign'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retry } from 'builder-util'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The bundle's main executable is the product itself: the Electron runtime that
 * owns the windows, the menu bar item, the browser, capture permissions and the
 * agent runs. Its name is what macOS shows (Dock, Applications, privacy dialogs,
 * Activity Monitor) and, through Squirrel's installer, the folder it installs
 * into, so it keeps the product name and is never swapped for a helper. The
 * native splash is a flat helper under Contents/Helpers that the app spawns.
 *
 * The identity rules are about updates and about notifications:
 *
 *   - the bundle is signed with its canonical bundle identifier. macOS's
 *     notification daemon (`usernotificationsd`) compares the *code-signing*
 *     identifier of the requesting process with the bundle identifier the
 *     request carries, and refuses every request when the two differ
 *     (`addRequest not allowed: <bundle id>`), because posting on behalf of a
 *     different identifier requires a private Apple entitlement. The result is
 *     `UNErrorDomain error 1` on every `show()`: no card, no prompt and no row
 *     in System Settings to switch on. Earlier builds inherited the signed
 *     Electron app's `<product>-electron` identifier and hit exactly that;
 *   - the bundle still carries a bridge requirement that accepts either the
 *     canonical bundle identifier or that legacy one, because Squirrel.Mac
 *     validates every update against the running process's designated
 *     requirement, and installs shipped under the legacy identifier must keep
 *     accepting updates.
 *
 * The identifier is asserted after signing: a build whose signature identity
 * does not match its bundle identifier ships an app that silently cannot
 * present a single macOS notification.
 */
export default async function macSign(configuration) {
  const appPath = configuration.app
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
  let mainExecutable = 'CodeInOven'
  let bundleIdentifier = ''
  try {
    const plist = await readFile(infoPlistPath, 'utf8')
    const executableMatch = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    if (executableMatch?.[1]) mainExecutable = executableMatch[1]
    const identifierMatch = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    bundleIdentifier = identifierMatch?.[1] ?? ''
  } catch {
    // The signer will fail below with a precise identity error.
  }
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) {
    throw new Error('Cannot sign the macOS Electron runtime without a valid CFBundleIdentifier')
  }

  const runtimeExecutable = mainExecutable
  // What installs shipped with before the canonical identifier: the update
  // requirement below has to keep accepting it.
  const legacyBinaryIdentifier = `${runtimeExecutable}-electron`

  const teamId = process.env['APPLE_TEAM_ID']?.trim() ?? ''
  const isAdHocSigning = configuration.identity === '-'
  if (!isAdHocSigning && !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error('APPLE_TEAM_ID is required for production macOS signing')
  }
  // osx-sign expects requirements strings to start with '=' (it pushes
  // `-r${requirements}` verbatim); codesign's -r then takes `=<requirements>`.
  const bridgeRequirement = isAdHocSigning
    ? undefined
    : `=designated => (identifier "${bundleIdentifier}" or identifier "${legacyBinaryIdentifier}") and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${teamId}`

  // Match the runtime by path suffix — osx-sign may hand us normalized or
  // relative forms of the discovered file path.
  const isRuntimeExecutable = (filePath) => {
    const normalized = String(filePath).replace(/^\.\/+/, '')
    return normalized.endsWith(`Contents/MacOS/${runtimeExecutable}`)
  }

  const originalOptionsForFile = configuration.optionsForFile
  configuration.optionsForFile = (filePath) => {
    const perFile = originalOptionsForFile ? originalOptionsForFile(filePath) : {}
    if (filePath === appPath || isRuntimeExecutable(filePath)) {
      return {
        ...perFile,
        ...(bridgeRequirement !== undefined ? { requirements: bridgeRequirement } : {}),
        // No `--identifier` override: codesign then stamps the bundle's own
        // CFBundleIdentifier, which is the identity the notification daemon
        // requires the requesting process to carry.
        additionalArguments: [...(perFile.additionalArguments ?? [])]
      }
    }
    return perFile
  }

  await retry(() => signAsync(configuration), {
    retries: 3,
    interval: 5000,
    backoff: 5000
  })

  await assertNotificationIdentity(appPath, mainExecutable, bundleIdentifier)
}

/** The `Identifier=` line codesign prints for a signed target. */
async function signatureIdentifier(target) {
  return new Promise((resolve) => {
    execFile('codesign', ['-d', '--verbose=2', target], (error, _stdout, stderr) => {
      if (error !== null && !stderr) {
        resolve(null)
        return
      }
      const identifier = /^Identifier=(.+)$/m.exec(stderr)?.[1]?.trim()
      resolve(identifier ?? null)
    })
  })
}

/**
 * Fail the build when the signed bundle and its main executable do not carry the
 * bundle identifier.
 *
 * This is not defensive padding: those identifiers are what macOS's notification
 * daemon compares before it accepts a request. A mismatch produces no error the
 * build can see, only an app whose notifications never appear and a Settings
 * pane that offers nothing to switch on.
 */
async function assertNotificationIdentity(appPath, mainExecutable, bundleIdentifier) {
  const targets = [
    { label: 'app bundle', path: appPath },
    { label: 'main executable', path: join(appPath, 'Contents', 'MacOS', mainExecutable) }
  ]
  for (const target of targets) {
    const signedAs = await signatureIdentifier(target.path)
    if (signedAs === null) {
      throw new Error(
        `Could not read the code-signing identifier of the ${target.label}; macOS notifications need it to match ${bundleIdentifier}`
      )
    }
    if (signedAs !== bundleIdentifier) {
      throw new Error(
        `The ${target.label} is signed as "${signedAs}" but its bundle identifier is "${bundleIdentifier}". ` +
          'macOS refuses every notification request whose signing identifier differs from the requested bundle identifier ' +
          '(usernotificationsd: addRequest not allowed), so the app would never show a card.'
      )
    }
  }
}
