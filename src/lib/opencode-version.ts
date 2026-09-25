/**
 * OpenCode install identity, shared by the main process and the renderer.
 *
 * OpenCode V1 and V2 both install as the `opencode` command: the vendor's own
 * migration guide states they are no longer installed side by side by default
 * and the V2 installer replaces the V1 binary. A package-managed V2 install may
 * additionally drop an `opencode2` alias on PATH, so the app treats it as an
 * alternate name for the SAME harness and picks whichever reports the newest
 * version. The user never chooses a version.
 *
 * This module must stay free of Node-only and Electron imports so it can be
 * bundled into the renderer as well as the main process.
 */

import { parseMajorVersion } from './version-compare'

/** The canonical command every OpenCode install provides. */
export const OPENCODE_COMMAND = 'opencode'

/** Alternate name a package-managed V2 install may also place on PATH. */
export const OPENCODE_COMMAND_ALIASES: readonly string[] = ['opencode2']

/** Every command that can satisfy the one `opencode` harness, canonical first. */
export const OPENCODE_COMMAND_CANDIDATES: readonly string[] = [
  OPENCODE_COMMAND,
  ...OPENCODE_COMMAND_ALIASES
]

/** A resolved OpenCode install: which command to spawn and what it reports. */
export interface OpenCodeInstallation {
  /** The candidate command that should be spawned for this install. */
  command: string
  /** First line of `<command> --version`. */
  version: string
  /** Parsed major version, or NaN when the line carried no number. */
  major: number
}

/** Pull the major version out of an OpenCode `--version` line. */
export function parseOpenCodeMajor(version: string): number {
  return parseMajorVersion(version)
}

/** True when a version line reports OpenCode V2 (major >= 2). */
export function isOpenCodeV2Version(version: string): boolean {
  const major = parseMajorVersion(version)
  return Number.isFinite(major) && major >= 2
}
