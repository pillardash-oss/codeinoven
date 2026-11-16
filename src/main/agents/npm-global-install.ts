import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** A globally installed CLI's own package manager and the prefix it lives under. */
export interface NpmGlobalInstall {
  /** The npm beside the binary, so the update uses the install's own toolchain. */
  npm: string
  /** That install's global root, e.g. `/usr/local` or `~/.nvm/versions/node/v24.18.0`. */
  prefix: string
}

/**
 * The npm that owns a globally installed CLI, and the prefix it owns it in.
 *
 * A global bin entry is a shim, and the npm shim starts with `#!/usr/bin/env
 * node`, so the `node` that runs it decides npm's global prefix. On a machine
 * with more than one Node version that is not necessarily the install whose
 * binary the app drives, and that is exactly how a Cline update "succeeded"
 * without moving: `cline update` spawns `npm update -g cline`, npm landed on a
 * different Node version's global root, Cline was not installed there, npm
 * answered "up to date" and exited 0, and Cline reported the new version. The
 * install the app reads the version from never changed.
 *
 * Passing the prefix that owns the resolved binary fixes that at the source:
 * whichever npm and node run, the update lands in the install the app drives.
 * Undefined for a binary that does not sit in a package manager's global
 * directory, so a standalone install keeps its vendor updater.
 */
export function npmGlobalInstallFor(binaryPath: string): NpmGlobalInstall | undefined {
  const binDirectory = dirname(binaryPath)
  const windows = process.platform === 'win32'
  const npm = windows ? join(binDirectory, 'npm.cmd') : join(binDirectory, 'npm')
  if (!existsSync(npm)) return undefined
  // A Unix install puts global bins in `<prefix>/bin` and npm's own package in
  // `<prefix>/lib/node_modules`; Windows keeps both directly in the prefix.
  const candidates = windows
    ? [{ npm, prefix: binDirectory }]
    : [{ npm, prefix: dirname(binDirectory) }]
  for (const candidate of candidates) {
    const npmPackage = windows
      ? join(candidate.prefix, 'node_modules', 'npm')
      : join(candidate.prefix, 'lib', 'node_modules', 'npm')
    if (existsSync(npmPackage)) return candidate
  }
  return undefined
}
