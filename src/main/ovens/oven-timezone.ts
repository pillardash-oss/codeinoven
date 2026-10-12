import type {
  OvenPrivilege,
  OvenTimezone,
  OvenTimezoneMethod,
  OvenTimezoneSyncResult
} from '../../lib/ovens'
import { sshQuote, type OvenSsh } from './oven-ssh'

/**
 * The clock-zone fields the shared preflight scripts emit.
 *
 * The zone is read three ways because no single one covers every POSIX Oven:
 * `timedatectl` names the zone directly on systemd hosts, the `/etc/localtime`
 * symlink answers on macOS and minimal images, and `/etc/timezone` is the
 * Debian convention. The first one that answers wins.
 */
export const TIMEZONE_POSIX_FIELDS = `tz_current=""
if command -v timedatectl >/dev/null 2>&1; then tz_current=$(timedatectl show -p Timezone --value 2>/dev/null || true); fi
if [ -z "$tz_current" ]; then
  tz_link=$(readlink -f /etc/localtime 2>/dev/null || true)
  case "$tz_link" in */zoneinfo/*) tz_current=\${tz_link#*/zoneinfo/} ;; esac
fi
if [ -z "$tz_current" ] && [ -r /etc/timezone ]; then tz_current=$(head -n 1 /etc/timezone 2>/dev/null || true); fi
field timezone.current "$tz_current"
if command -v timedatectl >/dev/null 2>&1; then field timezone.method timedatectl
elif [ "$(uname -s 2>/dev/null || echo)" = "Darwin" ] && [ -x /usr/sbin/systemsetup ]; then field timezone.method systemsetup
elif [ -d /usr/share/zoneinfo ] || [ -d /var/db/timezone/zoneinfo ]; then field timezone.method zoneinfo
else field timezone.method unsupported
fi`

/** Native Windows reads its zone from the platform's own catalogue. */
export const TIMEZONE_POWERSHELL_FIELDS = `Field 'timezone.current' ((Get-TimeZone).Id)
Field 'timezone.method' 'powershell'`

/** Every method a preflight may report, for validating what an Oven sent back. */
const TIMEZONE_METHODS: readonly OvenTimezoneMethod[] = [
  'timedatectl',
  'systemsetup',
  'zoneinfo',
  'powershell',
  'unsupported'
]

/** A zone id no shell has to quote: letters, digits, and the separators of a path. */
const ZONE_ID = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u

const TIMEZONE_TIMEOUT_MS = 45_000

/**
 * A clock within this many seconds of this computer is treated as correct.
 *
 * `apt` rejects a repository whose release timestamp is newer than the Oven's
 * own clock, so a zone change alone cannot rescue a clock running minutes
 * behind. This is the window the app refuses to rewrite.
 */
const CLOCK_TOLERANCE_SECONDS = 5

/** What is needed to move one Oven's clock onto another zone. */
export interface OvenClockObservation {
  platform: NodeJS.Platform
  privilege: OvenPrivilege
  timezone: OvenTimezone
}

/** One command that changes the clock, as the Oven shell must receive it. */
export interface OvenTimezoneCommand {
  /** The complete command line, quoted for the Oven's own shell. */
  line: string
  /** The same command as argv, used when elevation runs it through `sudo`. */
  elevatedArgv: string[]
  elevated: boolean
}

/**
 * This computer's own time zone, as the IANA id the Oven should follow.
 *
 * `Intl` names the zone on every platform Electron runs on, and a zone id that
 * failed validation is refused outright: it is about to be quoted into a remote
 * command, so nothing unverified travels with it.
 */
export function deviceTimezone(): string | null {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return typeof zone === 'string' && ZONE_ID.test(zone) ? zone : null
}

/** Turn the preflight fields one Oven emitted into its clock zone. */
export function parseOvenTimezone(fields: Map<string, string>): OvenTimezone {
  const method = fields.get('timezone.method') as OvenTimezoneMethod | undefined
  return {
    current: fields.get('timezone.current')?.trim() || null,
    method: method && TIMEZONE_METHODS.includes(method) ? method : 'unsupported'
  }
}

/** The zone encoded in a resolved `/etc/localtime` path, or null. */
export function timezoneFromLocaltimePath(path: string): string | null {
  const marker = '/zoneinfo/'
  const index = path.indexOf(marker)
  if (index < 0) return null
  const zone = path.slice(index + marker.length).trim()
  return zone && ZONE_ID.test(zone) ? zone : null
}

/**
 * Commands that put one Oven's clock on `zone`.
 *
 * Pure by construction, so the setup step and the settings action can never
 * disagree about how a platform changes its clock. A platform or privilege that
 * cannot express the change answers with the reason instead of a command that
 * would fail remotely.
 */
export function timezoneSetCommands(input: {
  platform: NodeJS.Platform
  method: OvenTimezoneMethod
  zone: string
  privilege: OvenPrivilege
}): OvenTimezoneCommand[] | { reason: string } {
  if (!ZONE_ID.test(input.zone)) return { reason: 'That is not a valid time zone id.' }
  // Only a root session needs no prefix: a passwordless-sudo user still runs the
  // change through `sudo -n`, exactly like every other elevated setup command.
  const elevated = input.privilege !== 'root'
  const argv = (command: string, args: string[], needsRoot: boolean): OvenTimezoneCommand => ({
    line: [command, ...args].map(sshQuote).join(' '),
    elevatedArgv: [command, ...args],
    elevated: needsRoot && elevated
  })

  if (input.platform === 'linux' && input.method === 'timedatectl')
    return [argv('timedatectl', ['set-timezone', input.zone], true)]

  if (input.platform === 'darwin' && input.method === 'systemsetup')
    return [argv('/usr/sbin/systemsetup', ['-settimezone', input.zone], true)]

  if ((input.platform === 'linux' || input.platform === 'darwin') && input.method === 'zoneinfo')
    return [
      argv('ln', ['-sfn', `/usr/share/zoneinfo/${input.zone}`, '/etc/localtime'], true),
      argv(
        'sh',
        ['-c', `if [ -e /etc/timezone ]; then printf '%s\\n' '${input.zone}' > /etc/timezone; fi`],
        true
      )
    ]

  if (input.platform === 'win32' && input.method === 'powershell') {
    if (input.privilege !== 'root')
      return {
        reason: 'Changing the clock zone on Windows needs an administrator SSH session on the Oven.'
      }
    return [windowsTimezoneCommand(input.zone)]
  }

  return {
    reason: 'This Oven has no supported way to change its clock zone.'
  }
}

/**
 * Windows names zones in its own catalogue, so the IANA id is converted by the
 * Oven itself.
 *
 * The whole script travels as one base64 `-EncodedCommand` payload: quoting a
 * multi-line PowerShell script through an SSH command line is exactly the kind
 * of thing that breaks on a shell nobody tested, and base64 carries no quoting
 * at all. The last line the script prints is the zone it ended on.
 */
function windowsTimezoneCommand(zone: string): OvenTimezoneCommand {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$iana = '${zone}'`,
    '$windows = $null',
    'if ($PSVersionTable.PSVersion.Major -ge 6) { [void][System.TimeZoneInfo]::TryConvertIanaIdToWindowsId($iana, [ref]$windows) }',
    'if (-not $windows) {',
    '  $exact = Get-TimeZone -ListAvailable | Where-Object { $_.Id -eq $iana } | Select-Object -First 1',
    '  if ($exact) { $windows = $exact.Id }',
    '}',
    'if (-not $windows) { throw "This Windows Oven cannot convert the IANA time zone $iana. Install PowerShell 7 on it, or set its clock zone by hand." }',
    'Set-TimeZone -Id $windows',
    '(Get-TimeZone).Id'
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return {
    line: `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
    elevatedArgv: ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    elevated: false
  }
}

/**
 * Commands that put one Oven's absolute clock on this computer's time.
 *
 * A zone change fixes how the clock is named, not what it reads, and `apt`
 * compares mirror release timestamps against the Oven's absolute clock. So a
 * clock running behind rejects repositories whatever its zone says. NTP is
 * switched off around the write on systemd hosts so the NTP client does not
 * immediately overwrite the correction, then switched back on.
 */
export function clockSetCommands(input: {
  platform: NodeJS.Platform
  method: OvenTimezoneMethod
  privilege: OvenPrivilege
  epochSeconds: number
}): OvenTimezoneCommand[] | { reason: string } {
  if (!Number.isSafeInteger(input.epochSeconds) || input.epochSeconds <= 0)
    return { reason: 'This computer did not report a usable clock.' }
  // Only a root session needs no prefix: a passwordless-sudo user still runs the
  // change through `sudo -n`, exactly like every other elevated setup command.
  const elevated = input.privilege !== 'root'
  const argv = (command: string, args: string[], needsRoot: boolean): OvenTimezoneCommand => ({
    line: [command, ...args].map(sshQuote).join(' '),
    elevatedArgv: [command, ...args],
    elevated: needsRoot && elevated
  })
  // Best-effort steps are wrapped so a missing tool cannot fail the clock write.
  const bestEffort = (script: string): OvenTimezoneCommand => argv('sh', ['-c', script], true)

  if (input.platform === 'linux') {
    const commands: OvenTimezoneCommand[] = []
    const systemd = input.method === 'timedatectl'
    if (systemd)
      commands.push(
        bestEffort(
          'command -v timedatectl >/dev/null 2>&1 && timedatectl set-ntp false >/dev/null 2>&1 || true'
        )
      )
    commands.push(argv('date', ['-u', '-s', `@${input.epochSeconds}`], true))
    commands.push(
      bestEffort('command -v hwclock >/dev/null 2>&1 && hwclock --systohc >/dev/null 2>&1 || true')
    )
    if (systemd)
      commands.push(
        bestEffort(
          'command -v timedatectl >/dev/null 2>&1 && timedatectl set-ntp true >/dev/null 2>&1 || true'
        )
      )
    return commands
  }

  if (input.platform === 'darwin')
    return [argv('date', ['-u', bsdDateStamp(input.epochSeconds)], true)]

  return { reason: 'This Oven has no supported way to set its clock.' }
}

/** BSD `date` set syntax, `[[[[cc]yy]mm]dd]HHMM[.ss]`, read as UTC under `-u`. */
export function bsdDateStamp(epochSeconds: number): string {
  const at = new Date(epochSeconds * 1000)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}.${pad(at.getUTCSeconds())}`
  )
}

/** Human-sized clock difference, for the one sentence a step reports. */
function describeOffset(seconds: number): string {
  const total = Math.abs(Math.round(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (rest > 0 && hours === 0) parts.push(`${rest}s`)
  return parts.length > 0 ? parts.join(' ') : '0s'
}

/** The Oven's own clock in epoch seconds, or null when it cannot be read. */
async function readOvenEpoch(ssh: OvenSsh, ovenId: string): Promise<number | null> {
  const output = await ssh.execute(ovenId, 'date +%s', '', TIMEZONE_TIMEOUT_MS)
  const value = Number.parseInt(output.trim().split(/\s+/u).pop() ?? '', 10)
  return Number.isFinite(value) ? value : null
}

/**
 * Match one Oven's absolute clock to this computer.
 *
 * Read first, then correct only when the difference is real, and verify by
 * reading the clock back: a command's exit code does not prove the Oven's clock
 * moved, and a wrong clock is what makes package repositories unusable.
 */
export async function syncOvenClock(
  ssh: OvenSsh,
  ovenId: string,
  observation: OvenClockObservation
): Promise<OvenTimezoneSyncResult> {
  if (observation.platform === 'win32')
    return {
      status: 'current',
      zone: observation.timezone.current,
      message: 'Windows keeps its own clock; CodeInOven matches the zone only.'
    }

  const localEpoch = Math.floor(Date.now() / 1000)
  const remoteEpoch = await readOvenEpoch(ssh, ovenId).catch(() => null)
  if (remoteEpoch === null)
    return {
      status: 'unsupported',
      zone: observation.timezone.current,
      message: 'CodeInOven could not read the Oven clock, so it could not check it.'
    }

  const offset = localEpoch - remoteEpoch
  if (Math.abs(offset) <= CLOCK_TOLERANCE_SECONDS)
    return {
      status: 'current',
      zone: observation.timezone.current,
      message: 'The Oven clock already matches this computer.'
    }

  /* Only root or a sudo-capable login can move the system clock. Reporting the
     offset rather than running a command that is certain to be refused keeps an
     Oven whose setup does not need the clock from failing over it, while still
     naming the reason for the one that does. */
  if (observation.privilege === 'none')
    return {
      status: 'unsupported',
      zone: observation.timezone.current,
      message: `The Oven clock is ${describeOffset(offset)} ${offset >= 0 ? 'behind' : 'ahead of'} this computer, and CodeInOven has no permission to set it there.`
    }

  const commands = clockSetCommands({
    platform: observation.platform,
    method: observation.timezone.method,
    privilege: observation.privilege,
    epochSeconds: localEpoch
  })
  if (!Array.isArray(commands))
    return { status: 'unsupported', zone: observation.timezone.current, message: commands.reason }

  for (const entry of commands) {
    if (entry.elevated)
      await ssh.executeElevated(
        ovenId,
        entry.elevatedArgv,
        TIMEZONE_TIMEOUT_MS,
        observation.privilege === 'sudo'
      )
    else await ssh.execute(ovenId, entry.line, '', TIMEZONE_TIMEOUT_MS)
  }

  const after = await readOvenEpoch(ssh, ovenId).catch(() => null)
  if (after === null || Math.abs(localEpoch - after) > CLOCK_TOLERANCE_SECONDS)
    throw new Error(
      `The Oven clock is still ${describeOffset(after === null ? offset : localEpoch - after)} off this computer after CodeInOven set it. Check the Oven time source, then retry this step.`
    )

  return {
    status: 'updated',
    zone: observation.timezone.current,
    message: `The Oven clock was ${describeOffset(offset)} ${offset >= 0 ? 'behind' : 'ahead of'} this computer and now matches it.`
  }
}

/**
 * Match one Oven's clock to this computer.
 *
 * The zone is verified by reading it back from the Oven, never by trusting the
 * command's exit code: `timedatectl` and `Set-TimeZone` both report success on
 * an Oven that then reports the old zone.
 */
export async function syncOvenTimezone(
  ssh: OvenSsh,
  ovenId: string,
  zone: string,
  observation: OvenClockObservation
): Promise<OvenTimezoneSyncResult> {
  const before = observation.timezone.current
  if (observation.platform !== 'win32' && before === zone)
    return {
      status: 'current',
      zone: before,
      message: `The Oven already runs on ${zone}.`
    }

  const commands = timezoneSetCommands({
    platform: observation.platform,
    method: observation.timezone.method,
    zone,
    privilege: observation.privilege
  })
  if (!Array.isArray(commands))
    return { status: 'unsupported', zone: before, message: commands.reason }

  for (const entry of commands) {
    if (entry.elevated)
      await ssh.executeElevated(
        ovenId,
        entry.elevatedArgv,
        TIMEZONE_TIMEOUT_MS,
        observation.privilege === 'sudo'
      )
    else await ssh.execute(ovenId, entry.line, '', TIMEZONE_TIMEOUT_MS)
  }

  if (observation.platform === 'win32') {
    const after = (
      await ssh.execute(
        ovenId,
        'powershell -NoProfile -Command "(Get-TimeZone).Id"',
        '',
        TIMEZONE_TIMEOUT_MS
      )
    )
      .trim()
      .split(/\r?\n/u)
      .filter(Boolean)
      .pop()
    return {
      status: after && after === before ? 'current' : 'updated',
      zone: after ?? null,
      message:
        after && after === before
          ? `The Oven already runs on ${zone}.`
          : `The Oven clock now follows ${zone}.`
    }
  }

  const resolved = await ssh.execute(
    ovenId,
    'readlink -f /etc/localtime 2>/dev/null || true',
    '',
    TIMEZONE_TIMEOUT_MS
  )
  const after = timezoneFromLocaltimePath(resolved.trim())
  if (after !== zone)
    throw new Error(
      `The Oven still reports ${after ?? 'an unreadable time zone'} after the clock change.`
    )
  return { status: 'updated', zone: after, message: `The Oven clock now follows ${zone}.` }
}
