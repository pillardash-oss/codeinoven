import { Buffer } from 'node:buffer'
import type { OvenSsh } from './oven-ssh'

/**
 * Which remote shell the Oven presents before anything that assumes one runs.
 *
 * Windows OpenSSH runs either cmd.exe or PowerShell, and a POSIX Oven runs
 * `sh`, `bash`, or a login shell. `echo %OS%` is unambiguous: cmd.exe expands it
 * to `Windows_NT`, every POSIX shell echoes it literally, and PowerShell echoes
 * it literally too, which is what lets PowerShell fall through. The trailing
 * `exit 0` keeps a shell whose `uname` (or `%OS%`) is missing from failing the
 * SSH exit code, and `;` is a no-op token in cmd rather than a separator, so a
 * cmd.exe host simply echoes the whole line.
 */
const DETECT = 'echo %OS%; uname -s; exit 0'

export type RemoteShell = 'posix' | 'cmd' | 'powershell'

/** Detect the remote shell without mutating anything on the Oven. */
export async function detectRemoteShell(ssh: OvenSsh, id: string): Promise<RemoteShell> {
  const output = (await ssh.execute(id, DETECT, '', 15_000)).trim()
  if (output.includes('Windows_NT')) return 'cmd'
  const lines = output.split(/\r?\n/u).map((line) => line.trim())
  if (lines.includes('Linux') || lines.includes('Darwin')) return 'posix'
  return 'powershell'
}

/** True for the two Windows shells, which share one command envelope. */
export function isWindowsShell(shell: RemoteShell): boolean {
  return shell === 'cmd' || shell === 'powershell'
}

/**
 * The command family for an Oven whose platform the app already knows.
 *
 * The encoded PowerShell envelope works whether the Windows default shell is
 * cmd.exe or PowerShell, so an already-known platform avoids a detection round
 * trip. Detection is only needed before the first probe.
 */
export function shellForPlatform(platform: string | undefined): RemoteShell {
  return platform === 'win32' ? 'powershell' : 'posix'
}

/**
 * One detection per transport instance and Oven.
 *
 * Detection costs a round trip, and the transport serializes them, so a probe or
 * a file-tree read that had to re-detect every time would feel broken. Keying
 * the cache on the `OvenSsh` instance is deliberate: a reconfigured Oven gets a
 * new transport and therefore a fresh answer, while an app-lifetime transport
 * asks once.
 */
const shellCache = new WeakMap<OvenSsh, Map<string, Promise<RemoteShell>>>()

export function remoteShell(ssh: OvenSsh, id: string): Promise<RemoteShell> {
  let perOven = shellCache.get(ssh)
  if (!perOven) {
    perOven = new Map()
    shellCache.set(ssh, perOven)
  }
  let pending = perOven.get(id)
  if (!pending) {
    pending = detectRemoteShell(ssh, id).catch((error: unknown) => {
      // A failed detection must not be cached, or a transient SSH error would
      // pin the Oven to a wrong shell for the life of the transport.
      perOven.delete(id)
      throw error
    })
    perOven.set(id, pending)
  }
  return pending
}

/**
 * Run a PowerShell script through an encoded command.
 *
 * The base64 alphabet (`A-Za-z0-9+/=`) means no quoting layer, whether the
 * remote shell is cmd.exe or PowerShell, and it leaves stdin free for the JSON
 * and bundle payloads the caller sends. PowerShell 5.1 ships with every
 * supported Windows, so no PowerShell 7 is assumed.
 */
export function windowsEncodedCommand(script: string, options: { interactive?: boolean } = {}): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const flags = options.interactive ? '-NoProfile -NoExit' : '-NoProfile -NonInteractive'
  return `powershell ${flags} -EncodedCommand ${encoded}`
}

/**
 * PowerShell single-quoted literal: the only escape is a doubled quote.
 *
 * Lives here beside the encoded-command envelope so the SSH layer can quote a
 * literal path without importing the command builders.
 */
export function powershellLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

/**
 * Shell helpers every generated POSIX probe starts from.
 *
 * `field` prints one tab-separated `key<TAB>value` row and flattens anything a
 * tool printed around the value, so a probe's output is always one line per
 * field no matter how chatty the tool is.
 */
export const POSIX_PROBE_HELPERS = `clean() { printf '%s' "$1" | tr '\\t\\n\\r' '   ' | cut -c1-512; }
field() { printf '%s\\t%s\\n' "$1" "$(clean "$2")"; }`

/** The Oven's own name for its platform, the shared first field of every probe. */
export const POSIX_PLATFORM_FIELD = `field os.uname "$(uname -s 2>/dev/null || echo unknown)"`

/** How much authority the authenticated user has for system mutation. */
export const POSIX_PRIVILEGE_FIELDS = `if [ "$(id -u 2>/dev/null || echo 1)" = "0" ]; then field privilege root
elif sudo -n true 2>/dev/null; then field privilege passwordless-sudo
elif command -v sudo >/dev/null 2>&1; then field privilege sudo
else field privilege none
fi`
