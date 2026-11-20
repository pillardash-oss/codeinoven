import { posix, win32 } from 'node:path'

/** Filesystem facts the path builder needs, injected so the rules stay testable. */
export interface RuntimePathProbe {
  exists: (path: string) => boolean
  /** Directory names, or an empty list when the directory is not there. */
  readDir: (path: string) => string[]
}

export interface RuntimePathInput {
  home: string
  /** The app's managed npm prefix, whose `bin` holds the harness shims. */
  npmPrefix: string
  /** The PATH the caller already has, kept last so the appended dirs only add. */
  basePath: string
  probe: RuntimePathProbe
  platform?: NodeJS.Platform
}

/**
 * The directories a harness needs on PATH that an SSH session does not give it.
 *
 * A harness shim is a script whose shebang is `#!/usr/bin/env node`, and the app's
 * managed npm prefix is not the only place that Node can live: nvm, volta, asdf
 * and mise all install a runtime under the user's home and only add it to PATH
 * from a login shell's startup files. The Oven service is started by an SSH exec
 * channel, which is not one, so the shims resolved and then died with exit 127
 * from `env`. The app's own npm prefix comes first because that is where it
 * installs harnesses, and the newest nvm runtime comes next so a machine with
 * several installed versions runs the one it last selected.
 */
export function runtimeBinDirs(input: RuntimePathInput): string[] {
  const { home, npmPrefix, probe, platform = process.platform } = input
  if (platform === 'win32') return [win32.join(home, npmPrefix, 'bin')]
  // Every POSIX path here is spelled the way the Oven spells it, so the shape
  // cannot depend on the machine that builds it: `join` turned `/home/u/bin`
  // into `\\home\\u\\bin` on a Windows host and broke the PATH it composed.
  const versionsRoot = posix.join(home, '.nvm', 'versions', 'node')
  const nvmVersions = probe
    .readDir(versionsRoot)
    .filter((entry) => /^v\d+\.\d+\.\d+$/u.test(entry))
    .sort(compareVersions)
    .reverse()
    .map((entry) => posix.join(versionsRoot, entry, 'bin'))
  const candidates = [
    posix.join(home, npmPrefix, 'bin'),
    ...nvmVersions,
    posix.join(home, '.volta', 'bin'),
    posix.join(home, '.asdf', 'shims'),
    posix.join(home, '.local', 'share', 'mise', 'shims'),
    posix.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  const seen = new Set<string>()
  const present: string[] = []
  for (const directory of candidates) {
    if (seen.has(directory) || !probe.exists(directory)) continue
    seen.add(directory)
    present.push(directory)
  }
  return present
}

/** Compose the PATH a harness runs with: the runtime dirs, then what the caller had. */
export function runtimePath(input: RuntimePathInput): string {
  const separator = input.platform === 'win32' ? ';' : ':'
  const dirs = runtimeBinDirs(input)
  const base = input.basePath.split(separator).filter(Boolean)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const directory of [...dirs, ...base]) {
    if (seen.has(directory)) continue
    seen.add(directory)
    ordered.push(directory)
  }
  return ordered.join(separator)
}

/** Sort `v22.9.0`-style names numerically rather than lexically. */
function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/u, '')
      .split('.')
      .map((part) => Number(part) || 0)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}
