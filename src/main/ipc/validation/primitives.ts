/** GitHub's opaque numeric IDs are not constrained to signed 32-bit integers. */
export const MAX_GITHUB_NUMERIC_ID = Number.MAX_SAFE_INTEGER

const SAFE_ENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

export function rejectUnknownFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  label: string
): void {
  for (const field of Object.keys(value)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`Unsupported ${label} field: ${field}`)
    }
  }
}

export function assertEnum<T extends string>(
  value: unknown,
  allowedValues: ReadonlySet<T>,
  label: string
): T {
  if (typeof value !== 'string' || !allowedValues.has(value as T)) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value as T
}

/** Validate an identifier that is safe to use as one filesystem path segment. */
export function validateEntityId(value: unknown, label = 'Entity ID', maximumLength = 128): string {
  const id = validateBoundedString(value, label, 1, maximumLength)
  if (id === '.' || id === '..' || !SAFE_ENTITY_ID.test(id)) {
    throw new TypeError(
      `${label} must contain only letters, numbers, dots, underscores, and hyphens`
    )
  }
  return id
}

export function validateBoolean(value: unknown, label = 'Value'): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${label} must be a boolean`)
  }
  return value
}

export function validateBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

/** A manual drag-reorder anchor: a finite, non-negative epoch timestamp (may be fractional). */
export function validateSortOrder(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError('Sort order must be a finite non-negative number')
  }
  return value
}

export function validateBoundedString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number
): string {
  if (typeof value !== 'string' || minimumLength < 0 || maximumLength < minimumLength) {
    throw new TypeError(
      `${label} must be a string between ${minimumLength} and ${maximumLength} characters`
    )
  }

  const sanitized = value.trim()
  if (
    sanitized.length < minimumLength ||
    sanitized.length > maximumLength ||
    sanitized.includes('\0')
  ) {
    throw new TypeError(
      `${label} must be a string between ${minimumLength} and ${maximumLength} characters`
    )
  }
  return sanitized
}
