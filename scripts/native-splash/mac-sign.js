import { sign as signAsync } from '@electron/osx-sign'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retry } from 'builder-util'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
 *
 * Implementation: both MacOS binaries are discovered by osx-sign's walk, which
 * signs all nested code before sealing the bundle with the final
 * `opts.app` sign. We never pre-sign or exclude anything ourselves — doing so
 * either desynchronizes hardened-runtime/timestamp flags or leaves the bundle
 * seal stale ("nested code is modified or invalid"). Instead we override the
 * identifier and designated requirement per file via `optionsForFile`, which
 * osx-sign applies to each codesign invocation it makes.
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
    return normalized.endsWith(`Contents/MacOS/${electronBinaryIdentifier}`)
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
      // The renamed Electron runtime keeps the canonical bundle identifier
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
