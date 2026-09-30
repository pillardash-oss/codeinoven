import type { GitRemoteIssue, GitRemoteIssueKind } from '../../lib/types'

/**
 * Reading a remote failure as the state it is.
 *
 * A fetch, push, pull or sync that does not finish because the device is
 * offline, because the account has no right to that repository, or because the
 * URL points nowhere is an expected condition the user resolves by acting.
 * Electron logs every rejected `ipcMain.handle` call with `console.error`, so
 * without this classification a five-minute background fetch on a laptop that
 * woke up without a network would print git's whole cause chain to the app log
 * for a state the panel can simply describe.
 *
 * git is the only source of the reason, and it words each one differently per
 * transport: an https token, an ssh key, and a proxy each leave their own
 * sentence behind. The markers below are the shapes git prints for each kind,
 * matched against the whole stderr text, because the line that carries the
 * reason is rarely the last one. Anything that matches no marker is not
 * classified here at all: an unexpected failure keeps rejecting so it stays
 * visible in the log, which is exactly where a defect belongs.
 */

/** The device could not reach the other end: DNS, routing, TLS, or a dropped session. */
const OFFLINE_MARKERS = [
  'could not resolve host',
  'temporary failure in name resolution',
  'network is unreachable',
  'no route to host',
  'connection refused',
  'connection reset by peer',
  'connection timed out',
  'operation timed out',
  'connection closed by remote host',
  'closed by remote host',
  'send disconnect',
  'broken pipe',
  'early eof',
  'empty reply from server',
  'remote end hung up unexpectedly',
  'failed to connect',
  'unable to connect',
  'ssl connect error',
  'ssl error',
  'gnutls_handshake() failed'
] as const

/**
 * The other end answered and refused this checkout: credentials it will not
 * accept, or an account without the right this operation needs. Matched after
 * the missing patterns, because GitHub answers a private repository it cannot
 * serve with "Repository not found" and only then reports an authentication
 * failure, and that missing sentence already names access as one of the two
 * things to check.
 */
const DENIED_MARKERS = [
  'authentication failed',
  'invalid username or password',
  'permission denied',
  'terminal prompts disabled',
  'could not read username',
  'could not read password',
  'access denied',
  'not authorized',
  'must be authenticated',
  'write access to repository not granted',
  'does not have permission',
  'returned error: 401',
  'returned error: 403'
] as const

/**
 * The other end answered that there is no such repository for this account.
 *
 * Matched by shape rather than by one literal, because git puts the URL between
 * the word "repository" and the verdict: `repository not found` and
 * `repository 'https://github.com/acme/typo.git/' not found` are the same
 * answer, and the second one is what a wrong URL actually prints. The gap is
 * bounded to one line, so a local failure that merely mentions a repository
 * cannot reach a "not found" from somewhere else in the text.
 */
const MISSING_PATTERNS = [
  /repositor(?:y|ies)[^\n]{0,300}?(?:not found|could not be found|does not exist)/u,
  /project[^\n]{0,300}?(?:not found|could not be found)/u,
  /does not appear to be a git repository/u,
  /returned error: 404/u
] as const

/**
 * git's umbrella line for "the round trip did not finish". It names no cause,
 * which is what a credential helper, a proxy, or a closed ssh session with
 * nothing else to say leaves behind, so it classifies as the unknown kind
 * instead of being guessed at.
 */
const UNREADABLE_MARKER = 'could not read from remote repository'

/**
 * The sentence the panel shows, written here rather than in the view because
 * every surface that describes a remote failure (the panel's notice and the
 * message a failed push hands back) has to say the same thing about it.
 */
const SENTENCES: Readonly<Record<GitRemoteIssueKind, string>> = {
  offline:
    'The remote could not be reached, and the device looks offline. Ahead and behind counts come from the last fetch that succeeded.',
  denied:
    'The remote refused this checkout. This account has no access to fetch from or push to it.',
  missing:
    "The remote points at no repository this account can read. Check the remote's URL and this project's access to it.",
  unknown:
    "The remote could not be read, and git named no cause. Check the connection and this project's access to it."
}

/** How much of git's own line the panel's hover detail keeps. */
const DETAIL_LIMIT = 200

/** How far down an error's cause chain the reason is looked for. */
const CAUSE_DEPTH = 4

/** git's own words for the failure, its cause chain included, before any matching. */
function failureText(failure: unknown): string {
  const parts: string[] = []
  let current: unknown = failure
  while (current instanceof Error && parts.length < CAUSE_DEPTH) {
    if (current.message) parts.push(current.message)
    current = current.cause
  }
  if (parts.length === 0) parts.push(String(failure))
  return parts.join('\n')
}

/**
 * The line of git's text that carries the reason, collapsed to one line and
 * bounded. git's stderr is a small paragraph: the cause comes first and the
 * umbrella sentence that follows it says nothing, so the first line that names
 * a specific kind wins over the umbrella, and a text that names only the
 * umbrella still reports it rather than nothing.
 */
function failureDetail(message: string): string {
  const lines = message
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  const named = lines.find((part) => {
    const kind = remoteIssueKind(part.toLowerCase())
    return kind !== null && kind !== 'unknown'
  })
  const line = named ?? lines[0]
  if (!line) return ''
  const collapsed = line.replace(/\s+/gu, ' ')
  return collapsed.length > DETAIL_LIMIT ? `${collapsed.slice(0, DETAIL_LIMIT - 1)}...` : collapsed
}

function matchesAny(normalized: string, markers: readonly string[]): boolean {
  return markers.some((marker) => normalized.includes(marker))
}

function matchesAnyPattern(normalized: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(normalized))
}

/**
 * The kind of remote failure `failure` is, or null when git's text names
 * nothing this module recognizes. Compared lowercased, because git varies the
 * capitalization of these sentences and its transport errors arrive under
 * whatever prefix the calling binary added.
 */
function remoteIssueKind(normalized: string): GitRemoteIssueKind | null {
  if (matchesAnyPattern(normalized, MISSING_PATTERNS)) return 'missing'
  if (matchesAny(normalized, DENIED_MARKERS)) return 'denied'
  if (matchesAny(normalized, OFFLINE_MARKERS)) return 'offline'
  if (normalized.includes(UNREADABLE_MARKER)) return 'unknown'
  return null
}

/**
 * Classify a failed git round trip against a remote, or null when it is not
 * one: a local failure (a lock, a missing repository, a bad revision) never
 * reaches this list, so it keeps rejecting and stays in the log.
 */
export function classifyGitRemoteFailure(failure: unknown): GitRemoteIssue | null {
  const message = failureText(failure)
  const kind = remoteIssueKind(message.toLowerCase())
  if (!kind) return null
  return { kind, message: SENTENCES[kind], detail: failureDetail(message) }
}
