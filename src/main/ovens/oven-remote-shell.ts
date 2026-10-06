import type { OvenSsh } from './oven-ssh'

/**
 * Which remote shell the Oven presents before anything that assumes one runs.
 *
 * Windows OpenSSH runs either cmd.exe or PowerShell, and a POSIX Oven runs
 * `sh`, `bash`, or a login shell. `echo %OS%` is unambiguous: cmd.exe expands it
 * to `Windows_NT`, every POSIX shell echoes it literally, and PowerShell echoes
 * it literally too, which is what lets PowerShell fall through to the PowerShell
 * collector instead of failing mid-script.
 */
const DETECT = `echo %OS%; uname -s 2>/dev/null || echo CIO_NO_UNAME`

export type RemoteShell = 'posix' | 'cmd' | 'powershell'

/** Detect the remote shell without mutating anything on the Oven. */
export async function detectRemoteShell(ssh: OvenSsh, id: string): Promise<RemoteShell> {
  const output = (await ssh.execute(id, DETECT, '', 15_000)).trim()
  if (output.includes('Windows_NT')) return 'cmd'
  const lines = output.split(/\r?\n/u).map((line) => line.trim())
  if (lines.includes('Linux') || lines.includes('Darwin')) return 'posix'
  return 'powershell'
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
