import type {
  OfferedProvider,
  ProviderAccountAuthStatus,
  ProviderAccountLoginHandoff
} from '$shared/types'

export type AddTab = 'connect' | 'custom'
export type ConnectStep = 'idle' | 'picking' | 'running' | 'labeling'

/** True when an offered provider matches a provider-search query. */
export function providerMatchesSearch(provider: OfferedProvider, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return provider.name.toLowerCase().includes(needle) || provider.id.toLowerCase().includes(needle)
}

export function shellCommand(handoff: ProviderAccountLoginHandoff): string {
  return [handoff.command, ...handoff.args]
    .map((part) =>
      /^[a-zA-Z0-9_./:@%+=,-]+$/u.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`
    )
    .join(' ')
}

export function stateLabel(authStatus: ProviderAccountAuthStatus | null): string {
  if (authStatus === null) return 'Not checked'
  switch (authStatus.state) {
    case 'authenticated':
      return `${authStatus.accounts.length} authenticated provider${
        authStatus.accounts.length === 1 ? '' : 's'
      }`
    case 'unauthenticated':
      return 'No providers connected'
    case 'unknown':
      return 'Status unknown'
    case 'error':
      return authStatus.detail ?? 'Error'
    case 'unsupported':
      return 'Sign-in not supported by this harness'
  }
}

/** Escape sequences the harness CLIs use for their boxes, colour and cursor. */
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'gu')

/** Lines the login terminal writes itself, never part of the CLI's answer. */
const TERMINAL_NOISE = new Set(['Starting process...', '[process exited]'])

/**
 * What the harness CLI said before it gave up.
 *
 * A sign-in that exits non-zero used to report its exit code alone, which left
 * the user with nothing to act on while the CLI had already named the reason (an
 * integration it does not know, a port its background service could not bind, a
 * key the provider rejected). The tail of the terminal is that reason, trimmed
 * to the lines that carry it and capped so a failure notice stays readable.
 */
export function loginFailureDetail(output: string): string {
  const lines = output
    .replace(ANSI_PATTERN, '')
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0 && !TERMINAL_NOISE.has(line))
  const detail = lines.slice(-4).join(' ').trim()
  return detail.length > 400 ? `${detail.slice(0, 397)}...` : detail
}
