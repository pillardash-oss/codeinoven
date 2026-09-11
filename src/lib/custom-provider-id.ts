/** Reserved namespace for custom base URL providers created by CodeInOven. */
export const CODEINOVEN_CUSTOM_PROVIDER_PREFIX = 'cio-'

/** Legacy previews briefly used the longer `cios-` spelling. Keep both isolated. */
export function isCodeInOvenCustomProviderId(providerId: string): boolean {
  const normalized = providerId.trim().toLocaleLowerCase('en-US')
  return normalized.startsWith(CODEINOVEN_CUSTOM_PROVIDER_PREFIX) || normalized.startsWith('cios-')
}

/**
 * Return the provider ID that an external usage service may know for a
 * CodeInOven custom provider. The CIO namespace identifies the local record,
 * not the upstream provider integration.
 */
export function underlyingProviderId(providerId: string): string | undefined {
  const normalized = providerId.trim().toLocaleLowerCase('en-US')
  const prefix = normalized.startsWith('cios-') ? 'cios-' : 'cio-'
  if (!normalized.startsWith(prefix)) return undefined
  const upstreamId = normalized.slice(prefix.length).trim()
  return upstreamId || undefined
}
