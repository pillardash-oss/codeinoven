import { OVEN_DATA_DIRECTORY } from './remote/oven-root-paths'
import { OVEN_HARNESS_PATH, OVEN_NPM_ENV } from './oven-harness-paths'
import { sshQuote } from './oven-ssh'
import {
  isWindowsShell,
  powershellLiteral,
  windowsEncodedCommand,
  type RemoteShell
} from './oven-remote-shell'

// Re-exported so the command builders and their callers share one quoting helper.
export { powershellLiteral }

/**
 * The app-managed directory and service file on a POSIX Oven, as shell text.
 *
 * `$HOME` is expanded by the login shell, so a version-managed Node runtime on
 * the Oven's PATH is still found while the service file stays under the user's
 * own home.
 */
const POSIX_ROOT = `"$HOME/${OVEN_DATA_DIRECTORY}"`
const POSIX_SERVICE = `"$HOME/${OVEN_DATA_DIRECTORY}/service.mjs"`

/** The same directory on a Windows Oven. */
const WINDOWS_ROOT_SEGMENT = OVEN_DATA_DIRECTORY.split('/').join('\\')

/**
 * The Node runtime check every POSIX runtime command starts from.
 *
 * The managed npm prefix is on PATH first, so a harness-bootstrapped Node is
 * found; a missing or too-old runtime fails before the service is touched.
 */
export const POSIX_NODE_CHECK =
  `${OVEN_HARNESS_PATH} ` +
  'set -eu; command -v node >/dev/null 2>&1 || { printf "Node.js is required on this Oven\\n" >&2; exit 1; }; node -e \'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)\''

function isEnvironmentName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
}

function environmentAssignments(environment: Record<string, string>): string[] {
  return Object.entries(environment).map(([name, value]) => {
    if (!isEnvironmentName(name) || value.includes('\0'))
      throw new TypeError('Invalid remote environment assignment.')
    return `$env:${name} = ${powershellLiteral(value)}`
  })
}

function posixEnvironment(environment: Record<string, string>): string {
  return (
    Object.entries(environment)
      .map(([name, value]) => {
        if (!isEnvironmentName(name) || value.includes('\0'))
          throw new TypeError('Invalid remote environment assignment.')
        return `${name}=${sshQuote(value)} `
      })
      .join('') || ''
  )
}

/**
 * Run the Oven service with one request payload on stdin.
 *
 * POSIX pipes SSH stdin straight into `node`; Windows reads the same stdin inside
 * PowerShell and forwards it, so the JSON framing is identical on both.
 */
export function remoteServiceCommand(
  shell: RemoteShell,
  args: readonly string[],
  options: { environment?: Record<string, string> } = {}
): string {
  const environment = options.environment ?? {}
  if (!isWindowsShell(shell)) {
    const prefix = posixEnvironment(environment)
    return `${POSIX_NODE_CHECK}; ${prefix}node ${POSIX_SERVICE} ${args.map(sshQuote).join(' ')}`
  }
  const windowsRoot = `Join-Path $env:USERPROFILE ${powershellLiteral(WINDOWS_ROOT_SEGMENT)}`
  const script = [
    `$service = Join-Path ${windowsRoot} 'service.mjs'`,
    `if (-not (Get-Command node -ErrorAction SilentlyContinue)) { [Console]::Error.WriteLine('Node.js is required on this Oven'); exit 1 }`,
    ...environmentAssignments(environment),
    `$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)`,
    `$data = $reader.ReadToEnd()`,
    `$data | & node $service ${args.map(powershellLiteral).join(' ')}`,
    `exit $LASTEXITCODE`
  ].join('\n')
  return windowsEncodedCommand(script)
}

/**
 * Install the service bundle arriving on stdin, then start the durable service.
 *
 * The staged file is verified against the revision before it can replace a
 * working service, exactly as the POSIX path verifies with `sha256sum`: a
 * truncated or corrupted delivery never becomes the file the app runs.
 */
export function remoteInstallServiceCommand(
  shell: RemoteShell,
  revision: string,
  token: string
): string {
  if (!/^[A-Za-z0-9-]{1,64}$/u.test(token)) throw new TypeError('Invalid remote install token.')
  if (!isWindowsShell(shell)) {
    return `${POSIX_NODE_CHECK}; umask 077; mkdir -p ${POSIX_ROOT}; staged="$HOME/${OVEN_DATA_DIRECTORY}/service.${token}.next"; trap 'rm -f "$staged"' EXIT; cat > "$staged"; hash=$( (sha256sum < "$staged" 2>/dev/null || shasum -a 256 "$staged") | cut -d ' ' -f 1); test "$hash" = ${sshQuote(revision)}; mv "$staged" ${POSIX_SERVICE}; CODEINOVEN_OVEN_REVISION=${sshQuote(revision)} node ${POSIX_SERVICE} ensure`
  }
  const windowsRoot = `Join-Path $env:USERPROFILE ${powershellLiteral(WINDOWS_ROOT_SEGMENT)}`
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `$root = ${windowsRoot}`,
    `New-Item -ItemType Directory -Force -Path $root | Out-Null`,
    `$service = Join-Path $root 'service.mjs'`,
    `$staged = Join-Path $root ('service.' + [guid]::NewGuid().ToString('N') + '.next')`,
    `$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)`,
    `$content = $reader.ReadToEnd()`,
    `[System.IO.File]::WriteAllText($staged, $content, (New-Object System.Text.UTF8Encoding($false)))`,
    `$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $staged).Hash.ToLowerInvariant()`,
    `if ($actual -ne ${powershellLiteral(revision)}) { Remove-Item -LiteralPath $staged -Force; throw 'The Oven service failed its integrity check after it was written.' }`,
    `Move-Item -LiteralPath $staged -Destination $service -Force`,
    `$env:CODEINOVEN_OVEN_REVISION = ${powershellLiteral(revision)}`,
    `$ErrorActionPreference = 'Continue'`,
    `& node $service ensure`,
    `exit $LASTEXITCODE`
  ].join('\n')
  return windowsEncodedCommand(script)
}

/**
 * One executable with structured arguments, quoted once for the Oven's shell.
 *
 * Elevation is POSIX-only on purpose: every Windows setup channel the plan can
 * produce (winget, Chocolatey, Scoop, npm) runs as the signed-in user, so a
 * Windows step never carries `sudo`.
 */
export function remoteArgvCommand(
  shell: RemoteShell,
  argv: readonly string[],
  options: { elevated?: boolean; prefix?: string } = {}
): string {
  if (argv.length === 0 || argv.some((value) => value.includes('\0')))
    throw new TypeError('Invalid remote command.')
  if (!isWindowsShell(shell)) {
    const words = options.elevated ? ['sudo', '-n', ...argv] : [...argv]
    return `${options.prefix ?? ''}${words.map(sshQuote).join(' ')}`
  }
  return windowsEncodedCommand(`& ${argv.map(powershellLiteral).join(' ')}`)
}

/** Read-only connection inspection, one tab-free line per system fact. */
export function connectionInspectCommand(shell: RemoteShell): string {
  if (!isWindowsShell(shell))
    return `set -eu
printf '%s\\n' "$(hostname)" "$(uname -s)" "$(uname -m)"
getconf _NPROCESSORS_ONLN 2>/dev/null || printf '0\\n'
if test -r /proc/meminfo; then awk '/^MemTotal:/ {printf "%.0f\\n", $2 * 1024; exit}' /proc/meminfo; else sysctl -n hw.memsize 2>/dev/null || printf '0\\n'; fi
df -Pk "$HOME" | awk 'NR==2 {printf "%.0f\\n%.0f\\n", $2 * 1024, $4 * 1024}'
command -v node >/dev/null 2>&1 && node --version || printf 'not-installed\\n'`
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$lines = New-Object System.Collections.Generic.List[string]`,
    `$lines.Add([System.Net.Dns]::GetHostName())`,
    `$lines.Add('Windows_NT')`,
    `$lines.Add([string]$env:PROCESSOR_ARCHITECTURE)`,
    `$lines.Add([string]([int]$env:NUMBER_OF_PROCESSORS))`,
    `$lines.Add([string]([long](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory))`,
    `$drive = New-Object System.IO.DriveInfo ([System.IO.Path]::GetPathRoot($env:USERPROFILE))`,
    `$lines.Add([string]([long]$drive.TotalSize))`,
    `$lines.Add([string]([long]$drive.AvailableFreeSpace))`,
    `if (Get-Command node -ErrorAction SilentlyContinue) { $lines.Add((& node --version)) } else { $lines.Add('not-installed') }`,
    `$lines -join "\`n"`
  ].join('\n')
  return windowsEncodedCommand(script)
}

/** Read one remote file as text, for the Oven's own known_hosts and keys. */
export function remoteReadFileCommand(shell: RemoteShell, path: string): string {
  if (!isWindowsShell(shell)) return `cat ${sshQuote(path)}`
  return windowsEncodedCommand(`Get-Content -LiteralPath ${powershellLiteral(path)} -Raw`)
}

export interface RemoteTerminalInput {
  shell: RemoteShell
  /** Checkout directory. Missing means the Oven user's home. */
  root: string | undefined
  environment: Record<string, string>
  /** Action script. Missing opens an interactive login shell. */
  script: string | undefined
}

/**
 * An interactive terminal or an action script on the Oven.
 *
 * POSIX replaces the shell process so signals reach the user's shell; Windows
 * keeps PowerShell open with `-NoExit` for an interactive session and runs an
 * action script as a child program.
 */
export function remoteTerminalCommand(input: RemoteTerminalInput): string {
  if (!isWindowsShell(input.shell)) {
    const target = input.root ? sshQuote(input.root) : '"$HOME"'
    const assignments = Object.entries(input.environment)
      .map(([name, value]) => `${name}=${sshQuote(value)}`)
      .join(' ')
    const shellExpression = '"${SHELL:-/bin/sh}"'
    const tail = input.script === undefined ? '-l' : `-lc ${sshQuote(input.script)}`
    return `${OVEN_HARNESS_PATH} cd ${target} && exec env ${assignments} ${shellExpression} ${tail}`
  }
  const lines = [
    ...environmentAssignments(input.environment),
    ...(input.root ? [`Set-Location -LiteralPath ${powershellLiteral(input.root)}`] : [])
  ]
  lines.push(input.script === undefined ? '' : `& { ${input.script} }`)
  return windowsEncodedCommand(lines.join('\n'), { interactive: input.script === undefined })
}

/** The managed npm prefix, only meaningful on a POSIX Oven. */
export { OVEN_HARNESS_PATH, OVEN_NPM_ENV }
