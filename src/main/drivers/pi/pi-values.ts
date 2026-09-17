/** Small shared value helpers and process utilities used across the Pi driver modules. */

/** The seed/reset shape of the per-session stop-flag file (no request pending). */
function emptyStopRequest(): { token: string; childSessionIds: string[] } {
  return { token: '', childSessionIds: [] }
}

/** Race one RPC probe against a deadline so a wedged process cannot block it. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function utilityKey(value: string): string {
  return (
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'utility'
  )
}

function errorText(value: Record<string, unknown>): string {
  return (
    stringValue(value['errorMessage']) ??
    stringValue(value['error']) ??
    stringValue(value['message']) ??
    'Pi turn failed'
  )
}

function messageTimestamp(value: Record<string, unknown>): number {
  return numberValue(value['timestamp']) ?? Date.now()
}

export {
  emptyStopRequest,
  withTimeout,
  record,
  stringValue,
  numberValue,
  utilityKey,
  errorText,
  messageTimestamp
}
