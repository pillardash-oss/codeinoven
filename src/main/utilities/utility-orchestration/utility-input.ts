import type { IncomingMessage } from 'http'
import { UTILITY_KIND_VALUES } from '../../../lib/types'
import type { UtilityKind } from '../../../lib/types'

const MAX_REQUEST_BYTES = 1_000_000

export function resolveEnvironmentReferences(
  values: Record<string, string>,
  environment: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_, name: string) => {
        const resolved = environment[name]
        if (resolved === undefined)
          throw new Error(`Credential environment is unavailable: ${name}`)
        return resolved
      })
    ])
  )
}

export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) throw new Error('Utility request is too large')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  return recordValue(parsed)
}

export function requiredString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return value.trim()
}

export function optionalString(value: unknown, maximum: number): string {
  if (value === undefined) return ''
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new TypeError('String input is invalid')
  }
  return value.trim()
}

export function optionalNumber(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('Numeric input is invalid')
  }
  return value
}

export function optionalKinds(value: unknown): Set<UtilityKind> | null {
  if (value === undefined) return null
  const allowed = new Set<UtilityKind>(UTILITY_KIND_VALUES)
  if (
    !Array.isArray(value) ||
    value.some((kind) => typeof kind !== 'string' || !allowed.has(kind as UtilityKind))
  ) {
    throw new TypeError('Utility kinds are invalid')
  }
  return new Set(value as UtilityKind[])
}

export function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected an object')
  return value
}

/** Explicit @cio-utility diagnostics require the app database; fail fast otherwise. */
export function requiredDatabase(
  database: import('../../database/database').Database | undefined
): import('../../database/database').Database {
  if (!database) throw new Error('App diagnostics are unavailable in this deployment')
  return database
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
