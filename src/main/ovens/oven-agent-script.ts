import { createHash } from 'node:crypto'
import {
  OVEN_MINIMUM_NODE_VERSION,
  type OvenAgentPlatform,
  type OvenAgentScript
} from '../../lib/ovens'
import { planNodeInstall, type NodeInstallPlan } from './oven-setup-bootstrap'
import type { OvenPackageManager } from '../../lib/ovens'

/** The heredoc/here-string markers that fence the embedded service bundle. */
const BUNDLE_MARKER = 'CODEINOVEN_OVEN_SERVICE_BUNDLE'

/**
 * Verify the embedded bundle before it is executed.
 *
 * Runs on the target machine, where `node` is guaranteed to exist by this point.
 * Kept as a standalone program so it can be syntax-checked and unit-tested.
 */
export const AGENT_VERIFY_PROGRAM = `const crypto = require('node:crypto')
const fs = require('node:fs')
const actual = crypto
  .createHash('sha256')
  .update(fs.readFileSync(process.env.CIO_AGENT_SERVICE_FILE))
  .digest('hex')
if (actual !== process.env.CIO_AGENT_REVISION) {
  console.error('The embedded Oven service failed its integrity check.')
  process.exit(1)
}`

/**
 * Assemble the registration descriptor on the target machine.
 *
 * The private key is read from the machine's own `~/.ssh` copy, never generated
 * here, so the key the app stores and the key already authorized are identical.
 */
export const AGENT_DESCRIPTOR_PROGRAM = `const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
let identity
if (process.env.CIO_AGENT_IDENTITY === '1') {
  const base = path.join(os.homedir(), '.ssh', 'codeinoven-oven-agent')
  identity = {
    algorithm: 'ed25519',
    privateKey: fs.readFileSync(base, 'utf8'),
    publicKey: fs.readFileSync(base + '.pub', 'utf8').trim()
  }
}
const descriptor = {
  kind: 'codeinoven-oven-agent',
  version: 1,
  protocolVersion: Number(process.env.CIO_AGENT_PROTOCOL),
  serviceRevision: process.env.CIO_AGENT_REVISION,
  platform: process.platform,
  architecture: process.arch,
  hostname: os.hostname(),
  user: process.env.CIO_AGENT_USER,
  port: Number(process.env.CIO_AGENT_PORT || '22'),
  name: os.hostname(),
  dataRoot: process.env.CIO_AGENT_DATA_ROOT,
  nodeVersion: process.versions.node,
  ...(identity ? { identity } : {}),
  createdAt: Date.now()
}
fs.writeFileSync(process.env.CIO_AGENT_DESCRIPTOR_FILE, JSON.stringify(descriptor, null, 2) + '\\n', {
  mode: 0o600
})
process.stdout.write(
  'codeinoven-oven-agent-v1:' + Buffer.from(JSON.stringify(descriptor)).toString('base64url') + '\\n'
)`

/** The candidate package managers attempted, in order, per platform family. */
const MANAGER_PROBE: readonly { file: string; manager: OvenPackageManager }[] = [
  { file: 'apt-get', manager: 'apt' },
  { file: 'dnf', manager: 'dnf' },
  { file: 'yum', manager: 'yum' },
  { file: 'pacman', manager: 'pacman' },
  { file: 'brew', manager: 'brew' },
  { file: 'winget', manager: 'winget' },
  { file: 'choco', manager: 'choco' },
  { file: 'scoop', manager: 'scoop' }
]

export interface OvenAgentScriptInput {
  platform: OvenAgentPlatform
  identity: boolean
  bootstrapNode: boolean
  /** The service bundle exactly as it will be embedded (trailing newline normalized). */
  service: string
  /** SHA-256 of `service`. */
  serviceRevision: string
  protocolVersion: number
}

/**
 * Build the self-contained Oven agent installer.
 *
 * The same script the app can push also works when a user runs it by hand: it
 * installs the durable daemon, optionally provisions a dedicated identity, and
 * prints a registration descriptor. It never requires an argument.
 */
export function buildOvenAgentScript(input: OvenAgentScriptInput): OvenAgentScript {
  if (input.service.includes(BUNDLE_MARKER))
    throw new Error('The Oven service bundle cannot be embedded: it contains the script marker.')
  if (input.platform === 'win32' && /(?:^|\n)'@/u.test(input.service))
    throw new Error('The Oven service bundle cannot be embedded in a PowerShell here-string.')
  if (createHash('sha256').update(input.service).digest('hex') !== input.serviceRevision)
    throw new Error('The Oven service bundle does not match the revision it was hashed as.')
  const content = input.platform === 'win32' ? windowsScript(input) : posixScript(input)
  return {
    filename: input.platform === 'win32' ? 'codeinoven-oven-agent.ps1' : 'codeinoven-oven-agent.sh',
    content,
    platform: input.platform,
    serviceRevision: input.serviceRevision,
    identity: input.identity,
    bootstrapNode: input.bootstrapNode
  }
}

/** Normalize the bundle to exactly one trailing newline so hashes and bytes agree. */
export function normalizeServiceBundle(source: string): string {
  return `${source.replace(/\n+$/u, '')}\n`
}

function posixScript(input: OvenAgentScriptInput): string {
  const managerDefinitions = managerProbeLines(input.platform)
  const installBody = input.bootstrapNode
    ? managerDefinitions
    : `  fail 'Node.js ${OVEN_MINIMUM_NODE_VERSION}+ is required. Install it and run this script again.'`
  const identityBlock = input.identity
    ? `identity_key="$HOME/.ssh/codeinoven-oven-agent"
mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
if [ ! -f "$identity_key" ]; then
  command -v ssh-keygen >/dev/null 2>&1 || fail 'OpenSSH (ssh-keygen) is required to provision the agent identity.'
  ssh-keygen -t ed25519 -N '' -C 'codeinoven-oven-agent' -f "$identity_key" >/dev/null
fi
chmod 600 "$identity_key"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
identity_public="$(cat "$identity_key.pub")"
grep -qF "$identity_public" "$HOME/.ssh/authorized_keys" 2>/dev/null ||
  printf '%s\\n' "$identity_public" >> "$HOME/.ssh/authorized_keys"`
    : `say 'No dedicated identity was requested; register the Oven with the account you already use.'`

  return `#!/bin/sh
# CodeInOven Oven agent installer (${input.platform}).
# Generated by CodeInOven. It is self-contained: run it on the machine that will
# become an Oven. It installs the durable service and prints a registration code.
set -eu

SERVICE_REVISION=${shellQuote(input.serviceRevision)}
PROTOCOL_VERSION=${shellQuote(String(input.protocolVersion))}
BOOTSTRAP_NODE=${shellQuote(input.bootstrapNode ? '1' : '0')}
IDENTITY_ENABLED=${shellQuote(input.identity ? '1' : '0')}
MIN_NODE_VERSION=${OVEN_MINIMUM_NODE_VERSION}
DATA_ROOT="\${CODEINOVEN_OVEN_DATA_ROOT:-$HOME/.config/pillardash/codeinoven-oven}"
PORT="\${CODEINOVEN_AGENT_PORT:-22}"

say() { printf '%s\\n' "$*"; }
fail() {
  printf 'Oven agent: %s\\n' "$*" >&2
  exit 1
}
run_elevated() {
  if [ "$(id -u)" = '0' ]; then "$@"; else sudo "$@"; fi
}
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e "process.exit((process.versions.node.split('.')[0] | 0) >= \${MIN_NODE_VERSION} ? 0 : 1)" >/dev/null 2>&1
}
install_node() {
${installBody}
}

say "CodeInOven Oven agent (${input.platform})"
if ! node_ok; then
  if [ "$BOOTSTRAP_NODE" = '1' ]; then
    say "Node.js \${MIN_NODE_VERSION}+ was not found; installing it."
    install_node
  fi
  node_ok || fail "Node.js \${MIN_NODE_VERSION}+ is required. Install it and run this script again."
fi

umask 077
mkdir -p "$DATA_ROOT"
chmod 700 "$DATA_ROOT"
service="$DATA_ROOT/service.mjs"
staged="$DATA_ROOT/service.$$.next"
trap 'rm -f "$staged"' EXIT
cat > "$staged" <<'${BUNDLE_MARKER}'
${input.service.replace(/\n$/u, '')}
${BUNDLE_MARKER}
CIO_AGENT_SERVICE_FILE="$staged" CIO_AGENT_REVISION="$SERVICE_REVISION" node <<'CODEINOVEN_VERIFY_PROGRAM'
${AGENT_VERIFY_PROGRAM}
CODEINOVEN_VERIFY_PROGRAM
chmod 600 "$staged"
mv "$staged" "$service"
say 'Service bundle installed.'

${identityBlock}

say 'Starting the durable Oven service.'
CIO_AGENT_USER="$(id -un 2>/dev/null || whoami)"
CIO_AGENT_SERVICE_FILE="$service" \\
  CIO_AGENT_REVISION="$SERVICE_REVISION" \\
  CIO_AGENT_PROTOCOL="$PROTOCOL_VERSION" \\
  CIO_AGENT_DATA_ROOT="$DATA_ROOT" \\
  CIO_AGENT_IDENTITY="$IDENTITY_ENABLED" \\
  CIO_AGENT_PORT="$PORT" \\
  CIO_AGENT_USER="$CIO_AGENT_USER" \\
  CIO_AGENT_DESCRIPTOR_FILE="$DATA_ROOT/agent-registration.json" \\
  CODEINOVEN_OVEN_REVISION="$SERVICE_REVISION" node "$service" ensure >/dev/null ||
  fail 'The durable Oven service did not start. Check the Node.js runtime on this machine.'

say 'Assembling the registration descriptor.'
registration="$(
  CIO_AGENT_REVISION="$SERVICE_REVISION" \\
    CIO_AGENT_PROTOCOL="$PROTOCOL_VERSION" \\
    CIO_AGENT_DATA_ROOT="$DATA_ROOT" \\
    CIO_AGENT_IDENTITY="$IDENTITY_ENABLED" \\
    CIO_AGENT_PORT="$PORT" \\
    CIO_AGENT_USER="$CIO_AGENT_USER" \\
    CIO_AGENT_DESCRIPTOR_FILE="$DATA_ROOT/agent-registration.json" \\
    node <<'CODEINOVEN_DESCRIPTOR_PROGRAM'
${AGENT_DESCRIPTOR_PROGRAM}
CODEINOVEN_DESCRIPTOR_PROGRAM
)"

say ''
say 'The Oven is ready. Paste this registration code into CodeInOven -> Settings -> Ovens -> Register agent.'
say "A copy is saved at $DATA_ROOT/agent-registration.json (owner-readable only)."
say ''
printf '%s\\n' "$registration"
`
}

function windowsScript(input: OvenAgentScriptInput): string {
  const installBody = input.bootstrapNode
    ? windowsNodeInstall()
    : `  throw 'Node.js ${OVEN_MINIMUM_NODE_VERSION}+ is required. Install it and run this script again.'`
  const identityBlock = input.identity
    ? `$identityKey = Join-Path $env:USERPROFILE '.ssh\\codeinoven-oven-agent'
$sshDirectory = Split-Path $identityKey
New-Item -ItemType Directory -Force -Path $sshDirectory | Out-Null
if (-not (Test-Path $identityKey)) {
  if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    throw 'OpenSSH (ssh-keygen) is required to provision the agent identity.'
  }
  & ssh-keygen -t ed25519 -N '""' -C 'codeinoven-oven-agent' -f $identityKey | Out-Null
}
$identityPublic = (Get-Content "$identityKey.pub" -Raw).Trim()
$authorizedKeys = Join-Path $sshDirectory 'authorized_keys'
if (-not (Test-Path $authorizedKeys)) { New-Item -ItemType File -Path $authorizedKeys | Out-Null }
if (-not (Select-String -Path $authorizedKeys -SimpleMatch $identityPublic -Quiet -ErrorAction SilentlyContinue)) {
  Add-Content -Path $authorizedKeys -Value $identityPublic
}
# OpenSSH on Windows ignores the per-user file for administrator accounts, which
# use the machine-wide file instead. Authorize the key there too, and say so
# plainly when that file cannot be written without an elevated shell.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  $adminKeys = Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $adminKeys) | Out-Null
    if (-not (Test-Path $adminKeys)) { New-Item -ItemType File -Path $adminKeys | Out-Null }
    if (-not (Select-String -Path $adminKeys -SimpleMatch $identityPublic -Quiet -ErrorAction SilentlyContinue)) {
      Add-Content -Path $adminKeys -Value $identityPublic
    }
  } catch {
    Write-Warning "Could not authorize the key for the administrators group. As Administrator, add this line to $adminKeys : $identityPublic"
  }
}`
    : `Write-Host 'No dedicated identity was requested; register the Oven with the account you already use.'`

  return `# CodeInOven Oven agent installer (Windows).
# Generated by CodeInOven. Run it on the machine that will become an Oven.
# It installs the durable service and prints a registration code.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$SERVICE_REVISION = ${powerShellQuote(input.serviceRevision)}
$PROTOCOL_VERSION = ${powerShellQuote(String(input.protocolVersion))}
$BOOTSTRAP_NODE = ${input.bootstrapNode ? '$true' : '$false'}
$IDENTITY_ENABLED = ${input.identity ? '$true' : '$false'}
$MIN_NODE_VERSION = ${OVEN_MINIMUM_NODE_VERSION}
$DATA_ROOT = if ($env:CODEINOVEN_OVEN_DATA_ROOT) { $env:CODEINOVEN_OVEN_DATA_ROOT } else { Join-Path $env:USERPROFILE '.config\\pillardash\\codeinoven-oven' }
$PORT = if ($env:CODEINOVEN_AGENT_PORT) { $env:CODEINOVEN_AGENT_PORT } else { '22' }

function Test-NodeOk {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  & node -e "process.exit((process.versions.node.split('.')[0] | 0) >= $MIN_NODE_VERSION ? 0 : 1)" 2>$null
  return ($LASTEXITCODE -eq 0)
}
function Install-Node {
${installBody}
}

Write-Host "CodeInOven Oven agent (Windows)"
if (-not (Test-NodeOk)) {
  if ($BOOTSTRAP_NODE) {
    Write-Host "Node.js $MIN_NODE_VERSION+ was not found; installing it."
    Install-Node
  }
  if (-not (Test-NodeOk)) {
    throw "Node.js $MIN_NODE_VERSION+ is required. Install it and run this script again."
  }
}

New-Item -ItemType Directory -Force -Path $DATA_ROOT | Out-Null
$service = Join-Path $DATA_ROOT 'service.mjs'
$staged = Join-Path $DATA_ROOT "service.$PID.next"
$bundle = @'
${input.service.replace(/\n$/u, '')}
'@
$bundle = $bundle.Replace([string][char]13, '')
[IO.File]::WriteAllText($staged, $bundle, (New-Object System.Text.UTF8Encoding($false)))
$env:CIO_AGENT_SERVICE_FILE = $staged
$env:CIO_AGENT_REVISION = $SERVICE_REVISION
@'
${AGENT_VERIFY_PROGRAM}
'@ | node -
if ($LASTEXITCODE -ne 0) { Remove-Item -Force $staged; throw 'The embedded Oven service failed its integrity check.' }
Move-Item -Force $staged $service
Write-Host 'Service bundle installed.'

${identityBlock}

Write-Host 'Starting the durable Oven service.'
$env:CIO_AGENT_SERVICE_FILE = $service
$env:CIO_AGENT_REVISION = $SERVICE_REVISION
$env:CIO_AGENT_PROTOCOL = $PROTOCOL_VERSION
$env:CIO_AGENT_DATA_ROOT = $DATA_ROOT
$env:CIO_AGENT_IDENTITY = if ($IDENTITY_ENABLED) { '1' } else { '0' }
$env:CIO_AGENT_PORT = $PORT
$env:CIO_AGENT_USER = $env:USERNAME
$env:CIO_AGENT_DESCRIPTOR_FILE = Join-Path $DATA_ROOT 'agent-registration.json'
$env:CODEINOVEN_OVEN_REVISION = $SERVICE_REVISION
& node $service ensure | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The durable Oven service did not start. Check the Node.js runtime on this machine.' }

Write-Host 'Assembling the registration descriptor.'
$registration = @'
${AGENT_DESCRIPTOR_PROGRAM}
'@ | node -

Write-Host ''
Write-Host 'The Oven is ready. Paste this registration code into CodeInOven -> Settings -> Ovens -> Register agent.'
Write-Host "A copy is saved at $DATA_ROOT\\agent-registration.json (owner-readable only)."
Write-Host ''
Write-Output $registration
`
}

/**
 * The POSIX `install_node` body: probe each manager the platform can have, then
 * run the documented plan command for it. The commands come from the same
 * `planNodeInstall` the in-app setup uses, so the two can never disagree.
 */
function managerProbeLines(platform: OvenAgentPlatform): string {
  const available =
    platform === 'darwin'
      ? MANAGER_PROBE.filter((entry) => entry.manager === 'brew')
      : MANAGER_PROBE.filter((entry) =>
          ['apt', 'dnf', 'yum', 'pacman', 'brew'].includes(entry.manager)
        )
  const lines: string[] = []
  for (const entry of available) {
    const plan = planNodeInstall(platform, 'x64', entry.manager, 'sudo')
    const rendered = posixPlanCommands(plan)
    lines.push(`  if command -v ${entry.file} >/dev/null 2>&1; then`)
    lines.push(rendered)
    lines.push('    return 0')
    lines.push('  fi')
  }
  if (platform === 'darwin') {
    lines.push(
      `  fail 'Homebrew is not installed. Install Node.js ${OVEN_MINIMUM_NODE_VERSION}+ or Homebrew, then run this script again.'`
    )
  } else {
    const nvm = planNodeInstall(platform, 'x64', 'unknown', 'sudo')
    lines.push('  # No package manager CodeInOven can drive was found; fall back to nvm.')
    lines.push(posixPlanCommands(nvm, '  '))
    lines.push('  return 0')
  }
  return lines.join('\n')
}

function posixPlanCommands(plan: NodeInstallPlan, indent = '    '): string {
  if (plan.commands.length === 0) {
    return `${indent}fail ${shellQuote(plan.detail)}`
  }
  return plan.commands
    .map((command) => {
      const rendered = [command.command, ...command.args].map(shellQuote).join(' ')
      return `${indent}${command.elevated ? 'run_elevated ' : ''}${rendered}`
    })
    .join('\n')
}

function windowsNodeInstall(): string {
  const lines: string[] = []
  for (const entry of MANAGER_PROBE.filter((item) =>
    ['winget', 'choco', 'scoop'].includes(item.manager)
  )) {
    const plan = planNodeInstall('win32', 'x64', entry.manager, 'none')
    if (plan.commands.length === 0) continue
    const command = plan.commands[0]
    const args = [...command.args]
    if (entry.manager === 'winget')
      args.push('--accept-source-agreements', '--accept-package-agreements')
    const rendered = [command.command, ...args].map(powerShellQuote).join(' ')
    lines.push(`  if (Get-Command ${entry.file} -ErrorAction SilentlyContinue) {`)
    lines.push(`    & ${rendered}`)
    lines.push('    return')
    lines.push('  }')
  }
  lines.push(
    `  throw 'No supported package manager was found. Install Node.js ${OVEN_MINIMUM_NODE_VERSION}+ from nodejs.org, then run this script again.'`
  )
  return lines.join('\n')
}

/** POSIX single-quote escaping: safe inside a `sh` script as a literal argument. */
function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A generated script value cannot contain null bytes.')
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** PowerShell single-quote escaping: double the quote, as PowerShell expects. */
function powerShellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('A generated script value cannot contain null bytes.')
  return `'${value.replace(/'/gu, "''")}'`
}
