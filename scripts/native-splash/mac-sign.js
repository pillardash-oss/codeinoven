import { sign as signAsync } from '@electron/osx-sign'
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
 * The identity rules that remain are about updates, not appearance:
 *
 *   - the bundle keeps the legacy signing identifier `<product>-electron`,
 *     because Squirrel.Mac validates every update against the running process's
 *     designated requirement, and installs signed with that identifier must keep
 *     accepting updates;
 *   - the bundle also carries a bridge requirement that accepts either the
 *     canonical bundle identifier or the legacy one, so a later move to the
 *     canonical identifier cannot strand existing installs.
 *
 * `codesign` signs `Foo.app/Contents/MacOS/Foo` as the bundle itself, so a
 * per-file identifier for the runtime never survives the bundle seal. The
 * identifier users and notifications see is the bundle identifier from
 * Info.plist (`com.pillardash.codeinoven`), which is unchanged.
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
  const electronBinaryIdentifier = `${runtimeExecutable}-electron`

  const teamId = process.env['APPLE_TEAM_ID']?.trim() ?? ''
  const isAdHocSigning = configuration.identity === '-'
  if (!isAdHocSigning && !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error('APPLE_TEAM_ID is required for production macOS signing')
  }
  // osx-sign expects requirements strings to start with '=' (it pushes
  // `-r${requirements}` verbatim); codesign's -r then takes `=<requirements>`.
  const bridgeRequirement = isAdHocSigning
    ? undefined
    : `=designated => (identifier "${bundleIdentifier}" or identifier "${electronBinaryIdentifier}") and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${teamId}`

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
        additionalArguments: [
          ...(perFile.additionalArguments ?? []),
          '--identifier',
          electronBinaryIdentifier
        ]
      }
    }
    return perFile
  }

  await retry(() => signAsync(configuration), {
    retries: 3,
    interval: 5000,
    backoff: 5000
  })
}
