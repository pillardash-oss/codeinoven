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
