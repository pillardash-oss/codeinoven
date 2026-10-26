import { AGENT_SECRET_ROOT } from './secret-request'

/** Pinned entries cannot be removed; the global protection switch still applies. */
export const PERMANENT_BUNDLED_PI_FILE_PATTERNS: readonly string[] = [`${AGENT_SECRET_ROOT}/**`]

/** Only the app-bundled Pi runtime consumes this policy. */
export const BUNDLED_PI_FILE_POLICY = 'bundled-pi-file-policy.json'
export const MAX_BUNDLED_PI_FILE_PATTERNS = 128
export const MAX_BUNDLED_PI_FILE_PATTERN_LENGTH = 256

export interface BundledPiFilePolicy {
  enabled: boolean
  patterns: string[]
}

export const DEFAULT_BUNDLED_PI_FILE_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '*.env',
  '*.env.*',
  '.pub',
  '*.pub',
  '*.pem',
  '*.key',
  '.ssh',
  '.aws',
  '.gnupg',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'secrets'
]

export function validateBundledPiFilePatterns(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_BUNDLED_PI_FILE_PATTERNS) {
    throw new TypeError(`Use at most ${MAX_BUNDLED_PI_FILE_PATTERNS} protected file patterns`)
  }
  const patterns: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') throw new TypeError('Protected file patterns must be text')
    const pattern = entry.trim()
    if (
      !pattern ||
      pattern.length > MAX_BUNDLED_PI_FILE_PATTERN_LENGTH ||
      Array.from(entry).some((character) => {
        const code = character.charCodeAt(0)
        return code < 32 || code === 127
      })
    ) {
      throw new TypeError('Protected file patterns must contain 1 to 256 printable characters')
    }
    if (!patterns.includes(pattern)) patterns.push(pattern)
  }
  return patterns
}

/** A missing or damaged stored policy must restore protection, never disable it. */
export function bundledPiFilePatterns(value: unknown): string[] {
  try {
    return value === undefined
      ? [...DEFAULT_BUNDLED_PI_FILE_PATTERNS]
      : validateBundledPiFilePatterns(value)
  } catch {
    return [...DEFAULT_BUNDLED_PI_FILE_PATTERNS]
  }
}

/** Migrate legacy pattern arrays; malformed policies keep protection enabled. */
export function bundledPiFilePolicy(value: unknown): BundledPiFilePolicy {
  try {
    if (Array.isArray(value))
      return { enabled: true, patterns: validateBundledPiFilePatterns(value) }
    if (value !== null && typeof value === 'object') {
      const policy = value as Record<string, unknown>
      if (typeof policy.enabled === 'boolean') {
        return { enabled: policy.enabled, patterns: validateBundledPiFilePatterns(policy.patterns) }
      }
    }
  } catch {
    // Defaults also cover a damaged policy that claims to be disabled.
  }
  return { enabled: true, patterns: [...DEFAULT_BUNDLED_PI_FILE_PATTERNS] }
}
