import type { OvenSsh } from './oven-ssh'
import {
  OVEN_HARNESS_COMMANDS,
  ovenHarnessIdForCommand,
  type OvenHarnessPreflight,
  type OvenPackageManager,
  type OvenPreflightReport,
  type OvenPrivilege,
  type OvenToolStatus
} from '../../lib/ovens'
import { findHarness } from '../agents/harness-registry'
import {
  harnessInstallChannels,
  preferredHarnessInstallChannel
} from '../agents/harness-install-service'
import {
  assessPreflight,
  harnessObservation,
  isSetupPlatform,
  resolvePackageManager
} from './oven-setup-capabilities'
import { OVEN_HARNESS_PATH } from './oven-harness-paths'
import {
  POSIX_PLATFORM_FIELD,
  POSIX_PRIVILEGE_FIELDS,
  POSIX_PROBE_HELPERS,
  detectRemoteShell,
  type RemoteShell
} from './oven-remote-shell'
import {
  TIMEZONE_POSIX_FIELDS,
  TIMEZONE_POWERSHELL_FIELDS,
  parseOvenTimezone
} from './oven-timezone'
import { Logger } from '../system/logger'

/**
 * Bump when the generated setup script or preflight output format changes in a
 * way an Oven cannot interpret. Persisted operations record the version they
 * ran with so a resumed operation is never resumed against a newer contract.
 */
export const OVEN_SETUP_SCRIPT_VERSION = 1

const HARNESS_TIMEOUT_SECONDS = 10

/** Read-only POSIX preflight. Emits tab-separated `key<TAB>value` lines. */
const POSIX_PREFLIGHT = `set -u
${OVEN_HARNESS_PATH}
${POSIX_PROBE_HELPERS}
harness() { field harness "$1|$2|$3"; }
limit() { if command -v timeout >/dev/null 2>&1; then timeout ${HARNESS_TIMEOUT_SECONDS} "$@"; else "$@"; fi; }
tool() {
  key=$1; shift
  probe_path=$(command -v "$1" 2>/dev/null || true)
  if [ -z "$probe_path" ]; then field "$key" absent; return 0; fi
  field "$key" present
  field "$key.path" "$probe_path"
  shift
  field "$key.version" "$(limit "$probe_path" "$@" 2>/dev/null | head -n 1 || true)"
}
${POSIX_PLATFORM_FIELD}
field os.arch "$(uname -m 2>/dev/null || echo unknown)"
field os.name "$(uname -s 2>/dev/null || echo unknown)"
if [ -r /etc/os-release ]; then . /etc/os-release 2>/dev/null || true; fi
field os.version "\${PRETTY_NAME:-\${VERSION:-unknown}}"
if [ "$(uname -s 2>/dev/null || echo)" = "Darwin" ]; then field os.version "$(sw_vers -productVersion 2>/dev/null || echo unknown)"; fi
field user.name "$(id -un 2>/dev/null || echo unknown)"
${POSIX_PRIVILEGE_FIELDS}
${TIMEZONE_POSIX_FIELDS}
for manager in brew winget apt-get dnf yum pacman zypper scoop choco; do
  if command -v "$manager" >/dev/null 2>&1; then field packageManager "$manager"; break; fi
done
tool git git --version
tool curl curl --version
tool node node --version
tool npm npm --version
if [ -e /var/run/reboot-required ] || [ -e /run/reboot-required ]; then field reboot.required true; else field reboot.required false; fi
case "$(command -v apt-get 2>/dev/null || true)" in
  /usr/bin/apt-get|/usr/local/bin/apt-get)
    field os.updates "$(limit apt-get -s -qq upgrade 2>/dev/null | grep -c '^Inst' || echo 0)"
    ;;
  *) field os.updates 0 ;;
esac
${OVEN_HARNESS_COMMANDS.map(
  (command) =>
    `harness ${command} "$(command -v ${command} 2>/dev/null || true)" "$(limit ${command} --version 2>/dev/null | head -n 1 || true)"`
).join('\n')}`

/** Read-only native Windows preflight through PowerShell. Same output format. */
const POWERSHELL_PREFLIGHT = `$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
function Field([string]$key, [string]$value) {
  $clean = ($value -replace "[\\t\\r\\n]", ' ').Trim()
  if ($clean.Length -gt 512) { $clean = $clean.Substring(0, 512) }
  "$key$([char]9)$clean"
}
function Tool([string]$key, [string]$command, [string[]]$arguments) {
  $resolved = Get-Command $command -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $resolved) { Field $key 'absent'; return }
  Field $key 'present'
  Field "$key.path" $resolved.Source
  $version = & $command @arguments 2>$null | Select-Object -First 1
  Field "$key.version" "$version"
}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) { Field 'privilege' 'root' }
else { Field 'privilege' 'none' }
Field 'os.name' "$($PSVersionTable.PSEdition) $($env:OS)"
Field 'os.uname' 'Windows_NT'
Field 'os.arch' $env:PROCESSOR_ARCHITECTURE
Field 'os.version' ([string](Get-CimInstance Win32_OperatingSystem).Version)
Field 'user.name' $env:USERNAME
${TIMEZONE_POWERSHELL_FIELDS}
foreach ($manager in @('winget', 'choco', 'scoop')) {
  if (Get-Command $manager -ErrorAction SilentlyContinue) { Field 'packageManager' $manager; break }
}
Tool 'git' 'git' @('--version')
Tool 'curl' 'curl.exe' @('--version')
Tool 'node' 'node' @('--version')
Tool 'npm' 'npm' @('--version')
$pending = (Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending' -ErrorAction SilentlyContinue) -ne $null
$pending = $pending -or ((Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') -eq $true)
Field 'reboot.required' $(if ($pending) { 'true' } else { 'false' })
Field 'os.updates' '0'
${OVEN_HARNESS_COMMANDS.map(
  (
    command
  ) => `$resolved${command} = Get-Command '${command}' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($resolved${command}) {
  $version${command} = & '${command}' --version 2>$null | Select-Object -First 1
  Field 'harness' "${command}|$($resolved${command}.Source)|$version${command}"
} else { Field 'harness' "${command}|" }`
).join('\n')}`

export type { RemoteShell }
export { detectRemoteShell }

interface ParsedFields {
  fields: Map<string, string>
  harnesses: Map<string, { path: string; version: string }>
}

/** Parse the tab-separated preflight output. Tolerant of one partial command. */
export function parsePreflightOutput(output: string): ParsedFields {
  const fields = new Map<string, string>()
  const harnesses = new Map<string, { path: string; version: string }>()
  for (const line of output.split(/\r?\n/u)) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const key = line.slice(0, tab).trim()
    const value = line.slice(tab + 1).trim()
    if (key === 'harness') {
      const [command = '', path = '', version = ''] = value.split('|')
      if (command) harnesses.set(command, { path: path.trim(), version: version.trim() })
      continue
    }
    if (key) fields.set(key, value)
  }
  return { fields, harnesses }
}

function toolStatus(fields: ParsedFields['fields'], key: string): OvenToolStatus {
  if (fields.get(key) !== 'present') return { installed: false, version: null, path: null }
  return {
    installed: true,
    version: fields.get(`${key}.version`)?.trim() || null,
    path: fields.get(`${key}.path`) ?? null
  }
}

function normalizeOsName(raw: string, platform: string): string {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === 'unknown') return platform
  if (/Windows_NT/u.test(trimmed) || platform === 'win32') return 'Windows'
  if (trimmed === 'Linux') return 'Linux'
  if (trimmed === 'Darwin') return 'macOS'
  return trimmed
}

function normalizePlatform(uname: string): NodeJS.Platform {
  if (uname === 'Linux') return 'linux'
  if (uname === 'Darwin') return 'darwin'
  if (uname === 'Windows_NT') return 'win32'
  return uname.toLowerCase() as NodeJS.Platform
}

function normalizeArchitecture(raw: string): string {
  const value = raw.trim().toLowerCase()
  if (value === 'x86_64' || value === 'amd64' || value === 'x64') return 'x64'
  if (value === 'aarch64' || value === 'arm64') return 'arm64'
  if (value === 'armv7l' || value === 'armv6l') return 'arm32'
  if (value.startsWith('i') && value.endsWith('86')) return 'ia32'
  return value || 'unknown'
}

function normalizePrivilege(raw: string): OvenPrivilege {
  if (raw === 'root' || raw === 'passwordless-sudo' || raw === 'sudo') return raw
  return 'none'
}

function harnessName(command: string): string {
  const harnessId = ovenHarnessIdForCommand(command)
  return (harnessId ? findHarness(harnessId)?.name : undefined) ?? command
}

function harnessChannels(
  command: string,
  platform: string
): { channels: string[]; supported: boolean; reason?: string } {
  if (!isSetupPlatform(platform))
    return { channels: [], supported: false, reason: `unsupported platform ${platform}` }
  const harnessId = ovenHarnessIdForCommand(command)
  if (!harnessId)
    return { channels: [], supported: false, reason: 'no canonical harness registration' }
  const channels = harnessInstallChannels(harnessId, platform)
  if (!channels || channels.length === 0)
    return {
      channels: [],
      supported: false,
      reason: 'no documented install channel for this platform'
    }
  return { channels: channels.map((channel) => channel.method), supported: true }
}

/** Turn raw preflight output into a typed report. Exported for the contract tests. */
export function buildPreflightReport(
  ovenId: string,
  shell: RemoteShell,
  output: string,
  durationMs: number
): OvenPreflightReport {
  const { fields, harnesses } = parsePreflightOutput(output)
  const platform = normalizePlatform(fields.get('os.uname') ?? '')
  const architecture = normalizeArchitecture(fields.get('os.arch') ?? '')
  const osName = normalizeOsName(fields.get('os.name') ?? '', platform)
  const privilege = normalizePrivilege(fields.get('privilege') ?? '')

  const observations: OvenHarnessPreflight[] = OVEN_HARNESS_COMMANDS.map((command) => {
    const observed = harnesses.get(command)
    const { channels, supported, reason } = harnessChannels(command, platform)
    return harnessObservation({
      command,
      name: harnessName(command),
      channels,
      executablePath: observed?.path || null,
      installedVersion: observed?.version || null,
      supported,
      ...(reason ? { unsupportedReason: reason } : {})
    })
  })

  const updates = Number.parseInt(fields.get('os.updates') ?? '0', 10)
  return {
    ovenId,
    checkedAt: Date.now(),
    platform,
    architecture,
    osName,
    osVersion: fields.get('os.version') || null,
    packageManager: resolvePackageManager(fields.get('packageManager') ?? null),
    privilege,
    git: toolStatus(fields, 'git'),
    curl: toolStatus(fields, 'curl'),
    node: toolStatus(fields, 'node'),
    npm: toolStatus(fields, 'npm'),
    timezone: parseOvenTimezone(fields),
    harnesses: observations,
    osUpdateRequired: Number.isFinite(updates) && updates > 0,
    ...(Number.isFinite(updates) && updates > 0
      ? {
          osUpdateDetail: `The Oven reports ${updates} pending package upgrade${updates === 1 ? '' : 's'}. CodeInOven upgrades packages only after you start setup, and never the operating-system release.`
        }
      : {}),
    rebootRequired: fields.get('reboot.required') === 'true',
    durationMs
  }
}

/**
 * Observe an oven without changing it. One bounded SSH round trip collects
 * hardware, privileges, package manager, prerequisites, and every harness
 * version together, because the transport serializes work and a setup check
 * that needs eight round trips feels broken on a slow link.
 */
export async function collectPreflight(ssh: OvenSsh, id: string): Promise<OvenPreflightReport> {
  const start = Date.now()
  const shell = await detectRemoteShell(ssh, id)
  const command =
    shell === 'posix'
      ? POSIX_PREFLIGHT
      : shell === 'powershell'
        ? `powershell -NoProfile -NonInteractive -Command @'\n${POWERSHELL_PREFLIGHT}\n'@`
        : null
  if (!command)
    throw new Error(
      'This Oven presents a Windows command shell CodeInOven cannot read. Configure OpenSSH on the Oven to use PowerShell, then try again.'
    )
  const output = await ssh.execute(id, command, '', 90_000)
  return buildPreflightReport(id, shell, output, Date.now() - start)
}

/**
 * Observe an oven and reduce it to the setup verdict in one call.
 */
export async function preflightOven(
  ssh: OvenSsh,
  id: string
): Promise<{ report: OvenPreflightReport; assessment: ReturnType<typeof assessPreflight> }> {
  const report = await collectPreflight(ssh, id)
  return { report, assessment: assessPreflight(report) }
}

export interface NodeInstallPlan {
  /** Commands that install Node.js 22+ when the Oven does not already run it. */
  commands: { command: string; args: string[]; elevated: boolean }[]
  method:
    'apt' | 'dnf' | 'yum' | 'pacman' | 'brew' | 'winget' | 'choco' | 'scoop' | 'nvm' | 'manual'
  elevated?: boolean
  detail: string
}

/**
 * Plan the smallest documented way to put a supported Node.js on the Oven.
 *
 * Package managers come first because they survive reboots and need no
 * interactive download. When the Oven has no package manager CodeInOven can
 * drive, the official NodeSource or nvm path is used instead of guessing.
 */
export function planNodeInstall(
  platform: NodeJS.Platform,
  architecture: string,
  packageManager: OvenPackageManager,
  privilege: OvenPrivilege
): NodeInstallPlan {
  const elevationSuffix =
    privilege === 'root' || privilege === 'passwordless-sudo'
      ? ''
      : ' requires elevation on this Oven.'
  const elevated = privilege !== 'root'
  const architectureSuffix = architecture === 'arm64' ? 'arm64' : 'x64'

  if (platform === 'darwin') {
    if (packageManager === 'brew')
      return {
        method: 'brew',
        elevated: false,
        detail: 'Installs Node.js 22 through Homebrew.',
        commands: [{ command: 'brew', args: ['install', 'node@22'], elevated: false }]
      }
    return {
      method: 'manual',
      elevated: false,
      detail: 'Install the official Node.js 22 package from nodejs.org, then run setup again.',
      commands: []
    }
  }

  if (platform === 'win32') {
    if (packageManager === 'winget')
      return {
        method: 'winget',
        elevated: false,
        detail: 'Installs the Node.js LTS package through winget.',
        commands: [
          {
            command: 'winget',
            args: ['install', '--id', 'OpenJS.NodeJS.LTS', '-e'],
            elevated: false
          }
        ]
      }
    if (packageManager === 'choco')
      return {
        method: 'choco',
        elevated: false,
        detail: 'Installs Node.js LTS through Chocolatey.',
        commands: [{ command: 'choco', args: ['install', 'nodejs-lts', '-y'], elevated: false }]
      }
    if (packageManager === 'scoop')
      return {
        method: 'scoop',
        elevated: false,
        detail: 'Installs Node.js LTS through Scoop.',
        commands: [{ command: 'scoop', args: ['install', 'nodejs-lts'], elevated: false }]
      }
    return {
      method: 'manual',
      elevated: false,
      detail: 'Install the official Node.js 22 installer from nodejs.org, then run setup again.',
      commands: []
    }
  }

  if (platform === 'linux') {
    if (packageManager === 'apt')
      return {
        method: 'apt',
        elevated,
        detail: `Adds the NodeSource 22.x repository and installs Node.js 22.${elevationSuffix}`,
        commands: [
          {
            command: 'sh',
            args: [
              '-c',
              `set -eu; apt-get install -y ca-certificates curl; curl -fsSL https://deb.nodesource.com/setup_22.x | bash -; apt-get install -y nodejs; node --version`
            ],
            elevated
          }
        ]
      }
    if (packageManager === 'dnf' || packageManager === 'yum')
      return {
        method: packageManager,
        elevated,
        detail: `Adds the NodeSource 22.x repository and installs Node.js 22 through ${packageManager}.${elevationSuffix}`,
        commands: [
          {
            command: 'sh',
            args: [
              '-c',
              `set -eu; curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -; ${packageManager} install -y nodejs; node --version`
            ],
            elevated
          }
        ]
      }
    if (packageManager === 'pacman')
      return {
        method: 'pacman',
        elevated,
        detail: `Installs Node.js through pacman.${elevationSuffix}`,
        commands: [{ command: 'pacman', args: ['-S', '--noconfirm', 'nodejs', 'npm'], elevated }]
      }
    if (packageManager === 'brew')
      return {
        method: 'brew',
        elevated: false,
        detail: 'Installs Node.js 22 through Homebrew.',
        commands: [{ command: 'brew', args: ['install', 'node@22'], elevated: false }]
      }
    return {
      method: 'nvm',
      elevated: false,
      detail: `Installs Node.js 22 through nvm for the ${architectureSuffix} user account, without touching system packages.`,
      commands: [
        {
          command: 'sh',
          args: [
            '-c',
            `set -eu; curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; . "$HOME/.nvm/nvm.sh"; nvm install 22; nvm alias default 22; node --version`
          ],
          elevated: false
        }
      ]
    }
  }

  return {
    method: 'manual',
    elevated: false,
    detail: 'Install Node.js 22 or later on this Oven, then run setup again.',
    commands: []
  }
}

/**
 * The channel setup will use for one harness on one platform. Preflight and
 * execution resolve the same channel so a harness can never be reported as
 * supported by the check and then skipped by the install.
 */
export function resolveHarnessChannel(command: string, platform: string) {
  if (!isSetupPlatform(platform)) return undefined
  const harnessId = ovenHarnessIdForCommand(command)
  if (!harnessId) return undefined
  return preferredHarnessInstallChannel(harnessId, platform)
}

/** Log the shell decision once per Oven without exposing command output. */
export function logShellDetection(id: string, shell: RemoteShell): void {
  Logger.dev('Oven shell detected', { ovenId: id, shell })
}
