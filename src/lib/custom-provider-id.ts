/** Reserved namespace for custom base URL providers created by CodeInOven. */
export const CODEINOVEN_CUSTOM_PROVIDER_PREFIX = 'cio-'

/** Legacy previews briefly used the longer `cios-` spelling. Keep both isolated. */
export function isCodeInOvenCustomProviderId(providerId: string): boolean {
  const normalized = providerId.trim().toLocaleLowerCase('en-US')
  return normalized.startsWith(CODEINOVEN_CUSTOM_PROVIDER_PREFIX) || normalized.startsWith('cios-')
}
