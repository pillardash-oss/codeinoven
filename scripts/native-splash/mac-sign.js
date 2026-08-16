import { signAsync } from '@electron/osx-sign'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { retry } from 'builder-util'

/**
 * The app uses a custom native-splash launcher architecture:
 *   - `Contents/MacOS/CodeInOven`        — the launcher, the bundle's main
 *     executable, signed with the bundle identifier `com.pillardash.codeinoven`
 *   - `Contents/MacOS/CodeInOven-electron` — the renamed Electron binary, signed
 *     with its basename identifier `CodeInOven-electron`
 *
 * The launcher `execv`s into `CodeInOven-electron`, so the RUNNING process is the
 * Electron binary. Squirrel.Mac captures the running process's designated
 * requirement (`identifier "CodeInOven-electron"`) and validates every update
 * bundle against it. Without a fix, that requirement can never be satisfied:
 * the update bundle's main executable is the launcher (identifier
 * `com.pillardash.codeinoven`), so every update fails with "code failed to
 * satisfy specified code requirement(s)".
 *
 * The fix: sign the app bundle with the SAME identifier as the renamed Electron
 * binary (`CodeInOven-electron`), so the launcher's DR matches the running
 * process's DR. Updates then validate on every install — including the
 * currently-deployed builds that run the Electron binary under that identifier.
 *
 * This override is applied only to the top-level bundle sign; helpers,
 * frameworks, and the Electron binary keep the identifiers osx-sign assigns
 * them by default.
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
