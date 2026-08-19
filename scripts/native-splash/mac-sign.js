import { signAsync } from '@electron/osx-sign'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { retry } from 'builder-util'

/**
 * The app uses a custom native-splash launcher architecture:
 *   - `Contents/MacOS/CodeInOven` — the launcher and bundle main executable
 *   - `Contents/MacOS/CodeInOven-electron` — the renamed Electron runtime
 *
 * The launcher `execv`s into `CodeInOven-electron`, so the RUNNING process is the
 * Electron binary. Squirrel.Mac captures the running process's designated
 * requirement (`identifier "CodeInOven-electron"`) and validates every update
 * bundle against it. Without a fix, that requirement can never be satisfied:
 * the update bundle's main executable is the launcher (identifier
 * `com.pillardash.codeinoven`), so every update fails with "code failed to
 * satisfy specified code requirement(s)".
 *
 * Existing installs run with the legacy `CodeInOven-electron` identifier, so
 * the top-level bundle must retain it for Squirrel.Mac update compatibility.
 * macOS UNNotification, however, rejects the running Electron process when its
 * signing identifier differs from CFBundleIdentifier. The runtime is therefore
 * signed with the canonical bundle identifier and a bridge designated
 * requirement that accepts both identities from the same Developer ID team.
 * Squirrel captures that bridge requirement from the running process, allowing
 * future update bundles to use either identifier without weakening the team or
 * Developer ID certificate constraints.
 *
 * Helpers and frameworks keep the identifiers osx-sign assigns by default.
 */
export default async function macSign(configuration) {
  const appPath = configuration.app
  const infoPlistPath = join(appPath, 'Contents', 'Info.plist')
  let mainExecutable = 'CodeInOven'
  try {
    const plist = await readFile(infoPlistPath, 'utf8')
    const match = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)
    if (match?.[1]) mainExecutable = match[1]
  } catch {
    // Fall back to the default above if the plist is not readable.
  }
  const electronBinaryIdentifier = `${mainExecutable}-electron`
  const electronExecutable = join(appPath, 'Contents', 'MacOS', electronBinaryIdentifier)
  configuration.binaries = [...new Set([...(configuration.binaries ?? []), electronExecutable])]
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
  const bridgeRequirement = isAdHocSigning
    ? undefined
    : `=designated => (identifier "${bundleIdentifier}" or identifier "${electronBinaryIdentifier}") and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamId}"`

  const originalOptionsForFile = configuration.optionsForFile
  configuration.optionsForFile = (filePath) => {
    const perFile = originalOptionsForFile ? originalOptionsForFile(filePath) : {}
    if (filePath === electronExecutable) {
      return {
        ...perFile,
        requirements: bridgeRequirement,
        additionalArguments: [
          ...(perFile.additionalArguments ?? []),
          '--identifier',
          bundleIdentifier
        ]
      }
    }
    if (filePath === appPath) {
      return {
        ...perFile,
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
