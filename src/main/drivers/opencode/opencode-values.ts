import { homedir } from 'node:os'
import { join } from 'node:path'
import { OPENCODE_ACCOUNT_PROVIDER_IDS } from '../opencode-provider-usage'

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const text = value.filter((entry): entry is string => typeof entry === 'string').join('\n')
  return text || undefined
}

/** Convert a value that may be a JSON string into a record. */
export function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  const asRecord = recordValue(value)
  if (asRecord) return asRecord
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Not JSON   treat as opaque string.
    }
  }
  return undefined
}

export function apiKeyFromOpenCodeAuth(value: unknown): string | undefined {
  const auth = recordValue(value)
  if (!auth) return undefined
  for (const providerId of OPENCODE_ACCOUNT_PROVIDER_IDS) {
    const entry = recordValue(auth[providerId])
    const key = stringValue(entry?.['key'])
    if (key) return key
  }
  return undefined
}

export function openCodeAuthPaths(
  environment: NodeJS.ProcessEnv,
  options: {
    /**
     * Return only the credential store the environment points at. A managed
     * account container sets `XDG_DATA_HOME`, and reading past it would let the
     * account see (and report) the user's default-home credentials.
     */
    scopedToDataHome?: boolean
  } = {}
): string[] {
  const home = homedir()
  const scoped = options.scopedToDataHome === true && Boolean(environment['XDG_DATA_HOME'])
  return [
    ...(environment['XDG_DATA_HOME']
      ? [join(environment['XDG_DATA_HOME'], 'opencode', 'auth.json')]
      : []),
    ...(!scoped && environment['LOCALAPPDATA']
      ? [join(environment['LOCALAPPDATA'], 'opencode', 'auth.json')]
      : []),
    ...(scoped
      ? []
      : [
          join(home, '.local', 'share', 'opencode', 'auth.json'),
          join(home, '.opencode', 'data', 'auth.json')
        ])
  ].filter((path, index, paths) => paths.indexOf(path) === index)
}

export function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'utility'
  )
}
