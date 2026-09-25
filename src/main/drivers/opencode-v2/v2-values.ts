/** Narrow an unknown JSON value to a plain object. */
export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function stringArray(value: unknown): string[] {
  return arrayValue(value).filter((entry): entry is string => typeof entry === 'string')
}

/** Convert a value that may be a JSON string into a record. */
export function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  const direct = recordValue(value)
  if (direct) return direct
  const text = stringValue(value)
  if (!text) return undefined
  try {
    return recordValue(JSON.parse(text) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Concatenate the text content V2 tool results carry.
 *
 * `Tool.Content` is an array of `{type:"text", text}` or `{type:"file", uri}`.
 * Only the text entries are rendered; a file entry contributes its name so the
 * tool card never shows an empty output.
 */
export function toolContentText(value: unknown): string | undefined {
  const parts: string[] = []
  for (const entry of arrayValue(value)) {
    const record = recordValue(entry)
    if (!record) continue
    if (record['type'] === 'text') {
      const text = stringValue(record['text'])
      if (text) parts.push(text)
      continue
    }
    if (record['type'] === 'file') {
      const name = stringValue(record['name']) ?? stringValue(record['uri'])
      if (name) parts.push(name)
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}
