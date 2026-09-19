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
