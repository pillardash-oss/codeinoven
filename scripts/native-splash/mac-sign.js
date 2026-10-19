import { sign as signAsync } from '@electron/osx-sign'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retry } from 'builder-util'

const __dirname = dirname(fileURLToPath(import.meta.url))

/**
 * The bundle entrypoint is CodeInOven Launcher; its supervised Electron runtime
 * is CodeInOven so macOS shows the product name for capture and process activity.
 * Preserve the legacy bundle signing identifier for existing Squirrel installs.
 * The runtime uses the canonical bundle identifier and a team-constrained bridge
 * requirement so notifications and subsequent updates retain their identity.
 */
export default async function macSign(configuration) {
  const appPath = configuration.app
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
  let mainExecutable = 'CodeInOven Launcher'
  try {
    const plist = await readFile(infoPlistPath, 'utf8')
    const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    if (match?.[1]) mainExecutable = match[1]
  } catch {
    // Fall back to the default above if the plist is not readable.
  }
  const runtimeExecutable = mainExecutable.replace(/ Launcher$/, '')
  const electronBinaryIdentifier = `${runtimeExecutable}-electron`
  let bundleIdentifier = ''
  try {
    const plist = await readFile(infoPlistPath, 'utf8')
    const match = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    bundleIdentifier = match?.[1] ?? ''
  } catch {
    // The signer will fail below with a precise identity error.
  }
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) {
    throw new Error('Cannot sign the macOS Electron runtime without a valid CFBundleIdentifier')
  }

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

  // Match the Electron runtime by path suffix — osx-sign may hand us
  // normalized or relative forms of the discovered file path.
  const isElectronBinary = (filePath) => {
    const normalized = String(filePath).replace(/^\.\/+/, '')
    return normalized.endsWith(`Contents/MacOS/${runtimeExecutable}`)
  }

  const originalOptionsForFile = configuration.optionsForFile
  configuration.optionsForFile = (filePath) => {
    const perFile = originalOptionsForFile ? originalOptionsForFile(filePath) : {}
    if (filePath === appPath) {
      // The top-level bundle sign must keep the legacy running-process
      // identifier for Squirrel.Mac update compatibility.
      return {
        ...perFile,
        additionalArguments: [
          ...(perFile.additionalArguments ?? []),
          '--identifier',
          electronBinaryIdentifier
        ]
      }
    }
    if (isElectronBinary(filePath)) {
      // The product-named Electron runtime keeps the canonical bundle identifier
      // (required by macOS UNNotification) plus the bridge requirement so
      // Squirrel.Mac accepts update bundles signed with either identifier.
      return {
        ...perFile,
        ...(bridgeRequirement !== undefined ? { requirements: bridgeRequirement } : {}),
        additionalArguments: [
          ...(perFile.additionalArguments ?? []),
          '--identifier',
          bundleIdentifier
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
