import { sign as signAsync } from '@electron/osx-sign'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retry } from 'builder-util'

const __dirname = dirname(fileURLToPath(import.meta.url))

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

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
    : `designated => (identifier "${bundleIdentifier}" or identifier "${electronBinaryIdentifier}") and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = ${teamId}`

  // Both CodeInOven (launcher) and CodeInOven-electron (Electron runtime) live
  // in Contents/MacOS/, so osx-sign's isBundleMainExecutable() matches both. They
  // get the same signing rank, and osx-sign's stable sort keeps discovery order —
  // launcher first alphabetically. The launcher is then signed first, which seals
  // the bundle with the electron binary still unsigned. When the electron binary is
  // signed second, it modifies the sealed bundle, and macOS 26's codesign --verify
  // --strict rejects it with "nested code is modified or invalid".
  //
  // Fix: pre-sign the electron binary directly with codesign BEFORE osx-sign walks
  // the bundle, then exclude it from osx-sign's discovery so it isn't double-signed.
  const electronSignArgs = [
    '--sign', configuration.identity,
    '--force',
    '--identifier', bundleIdentifier,
    '--entitlements', join(__dirname, '../../node_modules/@electron/osx-sign/entitlements/default.darwin.plist'),
    '--timestamp'
  ]
  if (bridgeRequirement) {
    // codesign's -r flag expects the requirement as `=<requirements source>`,
    // e.g. `-r=designated => ...`. The bridge requirement is stored without a
    // leading '=' so we join it as `-r=` + requirement here.
    electronSignArgs.push(`-r=${bridgeRequirement}`)
  }
  if (configuration.keychain) {
    electronSignArgs.push('--keychain', configuration.keychain)
  }
  electronSignArgs.push(electronExecutable)
  await execFileAsync('codesign', electronSignArgs)

  // Exclude the pre-signed electron binary from osx-sign's walk so it isn't
  // re-signed after the launcher seals the bundle.
  const originalIgnore = configuration.ignore
  configuration.ignore = [
    ...(Array.isArray(originalIgnore) ? originalIgnore : originalIgnore ? [originalIgnore] : []),
    // osx-sign may pass ignore-callback paths in a normalized or relative
    // form, so match the Electron runtime by path suffix instead of strict
    // equality — a missed match means it gets re-signed after the launcher
    // seals the bundle, and macOS 26's strict verify rejects the bundle with
    // "nested code is modified or invalid".
    (filePath) => {
      const normalized = String(filePath).replace(/^\.\//, '')
      return normalized.endsWith(`/${electronBinaryIdentifier}`) || normalized === electronExecutable
    }
  ]

  const originalOptionsForFile = configuration.optionsForFile
  configuration.optionsForFile = (filePath) => {
    const perFile = originalOptionsForFile ? originalOptionsForFile(filePath) : {}
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
