import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * WSL helpers shared by the Oven service and the desktop's Oven commands.
 *
 * Nothing here may import Electron or an app path: the Oven service is a
 * standalone Node program copied onto the Oven, so this module has to run with
 * Node alone. Everything is pure or reads the filesystem, so both sides of the
 * SSH boundary agree on how a WSL harness is addressed.
 */

/**
 * Distributions that exist to run containers rather than to host a harness.
 *
 * WSL lists them beside real distributions, and a harness can never be found in
 * one, so probing them only costs a cold start.
 */
export const NON_INTERACTIVE_WSL_DISTRIBUTIONS = new Set([
  'docker-desktop',
  'docker-desktop-data',
  'podman-machine-default'
])

/**
 * Resolve a set of commands inside one distribution in a single call.
 *
 * WSL startup dominates a probe, so every command is resolved in one `sh -c`
 * pass that receives them as positional parameters. The login PATH is applied
 * first because a distro's own `~/.local/bin` is exactly where these installers
 * put their binaries, and a non-interactive `sh` does not read the profile that
 * would add it.
 */
export const WSL_DISCOVERY_SCRIPT =
  'login_path=$("${SHELL:-/bin/sh}" -lic \'printenv PATH\' 2>/dev/null || true); ' +
  'if [ -n "$login_path" ]; then PATH=$login_path; export PATH; fi; ' +
  'for command_name do command_path=$(command -v "$command_name" 2>/dev/null || true); ' +
  'printf "%s\\t%s\\n" "$command_name" "$command_path"; done'

/**
 * `wsl.exe --list` answers in UTF-16LE even on a pipe; commands it runs inside a
 * distribution answer in UTF-8. A byte-order mark is conclusive, and otherwise a
 * high proportion of zero bytes is the reliable tell for BOM-less UTF-16.
 */
export function decodeWslOutput(value: Buffer): string {
  if (value.length >= 2 && value[0] === 0xff && value[1] === 0xfe)
    return value.subarray(2).toString('utf16le')
  let zeroBytes = 0
  for (let index = 1; index < value.length; index += 2) if (value[index] === 0) zeroBytes += 1
  return zeroBytes > value.length / 8 ? value.toString('utf16le') : value.toString('utf8')
}

/** The `wsl.exe` a Windows Oven ships, or undefined on any other platform. */
export function windowsWslExecutablePath(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv
): string | undefined {
  if (platform !== 'win32') return undefined
  const candidate = join(environment['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wsl.exe')
  return existsSync(candidate) ? candidate : undefined
}

/** One POSIX shell word, single-quoted so nothing inside it can expand. */
export function posixQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/**
 * The distribution a `\\wsl$` or `\\wsl.localhost` path names, if any.
 *
 * A workspace opened through one of those roots belongs to that distribution,
 * so a harness for it has to resolve and run there rather than in whichever
 * distribution happens to be default.
 */
export function wslDistributionFromUncPath(path: string | undefined): string | undefined {
  if (!path) return undefined
  return /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/iu.exec(path)?.[1]
}

/**
 * The Linux path the same directory has inside a distribution.
 *
 * A Windows drive becomes `/mnt/<drive>`. A `\\wsl$` or `\\wsl.localhost` UNC
 * path is already inside a distribution, so it converts to its own absolute
 * path when the distribution matches the one being addressed.
 */
export function wslPathFromWindows(path: string, distribution: string): string {
  const unc = /^\\\\wsl(?:\$|\.localhost)\\([^\\]+)\\(.*)$/iu.exec(path)
  if (unc) {
    const rest = unc[2]!.split('\\').filter(Boolean).join('/')
    const same = unc[1]!.toLocaleLowerCase('en-US') === distribution.toLocaleLowerCase('en-US')
    if (same) return `/${rest}`
  }
  const drive = /^([A-Za-z]):[\\/](.*)$/u.exec(path)
  if (drive) {
    const rest = drive[2]!.split(/[\\/]/u).filter(Boolean).join('/')
    return `/mnt/${drive[1]!.toLocaleLowerCase('en-US')}/${rest}`
  }
  return `/${path.split(/[\\/]/u).filter(Boolean).join('/')}`
}

/**
 * The `wsl.exe` argv that runs one harness with its arguments left intact.
 *
 * The harness path and every argument cross as positional parameters rather than
 * shell text, so a prompt or a path containing quotes arrives exactly as the
 * caller sent it, and the only string this has to quote is the working
 * directory.
 */
export function wslRunArgv(
  distribution: string,
  harnessPath: string,
  args: readonly string[],
  cwd: string
): string[] {
  const script = `cd ${posixQuote(wslPathFromWindows(cwd, distribution))} && exec "$0" "$@"`
  return ['--distribution', distribution, '--', 'sh', '-lc', script, harnessPath, ...args]
}

/** The `wsl.exe` argv that runs one shell script inside a distribution. */
export function wslScriptArgv(distribution: string, script: string): string[] {
  return ['wsl.exe', '--distribution', distribution, '--', 'sh', '-lc', script]
}

/**
 * The shell text that runs one documented install or update channel inside WSL.
 *
 * The native one-line installers are already a shell script, so they run as
 * written. Anything else becomes one quoted argv, which is what keeps a command
 * like `npm install -g <package>` from being split by the shell.
 */
export function wslChannelScript(command: string, args: readonly string[]): string {
  if (command === 'sh' && args.length === 2 && args[0] === '-lc') return args[1]!
  return ['exec', command, ...args].map(posixQuote).join(' ')
}
