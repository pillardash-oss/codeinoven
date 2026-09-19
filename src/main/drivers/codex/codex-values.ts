/** Low-level Codex app-server value guards and payload readers. */

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export function notificationThreadId(params: Record<string, unknown>): string | undefined {
  const turn = record(params['turn'])
  return (
    stringValue(params['threadId']) ??
    stringValue(params['thread_id']) ??
    stringValue(turn?.['threadId']) ??
    stringValue(turn?.['thread_id'])
  )
}

export function toolInput(item: Record<string, unknown>): Record<string, unknown> {
  for (const key of ['arguments', 'input', 'params']) {
    const value = item[key]
    const record = recordValue(value)
    if (record) return record
    if (typeof value !== 'string') continue
    try {
      const parsed = JSON.parse(value)
      const parsedRecord = recordValue(parsed)
      if (parsedRecord) return parsedRecord
    } catch {
      // Preserve schema tolerance for non-JSON provider payloads.
    }
  }
  for (const key of ['plan', 'steps', 'tasks', 'todos', 'todoList', 'todo_list', 'checklist']) {
    if (Array.isArray(item[key])) return { [key]: item[key] }
  }
  if (Array.isArray(item['changes'])) return { changes: item['changes'] }
  return {}
}

export function toolOutput(item: Record<string, unknown>): string | undefined {
  for (const key of ['result', 'output', 'aggregated_output']) {
    const text = outputText(item[key])
    if (text) return text
  }
  return undefined
}

export function outputText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (Array.isArray(value)) {
    const text = value
      .map(outputText)
      .filter((entry): entry is string => Boolean(entry))
      .join('\n')
    return text || undefined
  }
  const record = recordValue(value)
  if (!record) return undefined

  const nested = ['text', 'content', 'output', 'result', 'structured_content']
    .map((key) => outputText(record[key]))
    .filter((entry): entry is string => Boolean(entry))
  if (nested.length > 0) return [...new Set(nested)].join('\n')

  try {
    return JSON.stringify(record)
  } catch {
    return undefined
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function appServerRequestId(value: unknown): string | number | undefined {
  return stringValue(value) ?? numberValue(value)
}

export function arrayText(value: unknown): string {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string').join('\n')
    : ''
}

export function errorText(value: Record<string, unknown>): string {
  return stringValue(value['message']) ?? stringValue(value['error']) ?? 'Codex CLI failed'
}
