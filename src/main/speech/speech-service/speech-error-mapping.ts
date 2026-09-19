import type { SpeechError, SpeechResult } from '../../../lib/speech/types'
import { SpeechQueueError } from '../speech-job-queue'

/** Map any thrown value onto the structured speech error the IPC contract expects. */
export function toSpeechError(cause: unknown, fallback: SpeechError['code']): SpeechError {
  if (cause instanceof SpeechQueueError) return cause.speechError
  return {
    code: fallback,
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: true
  }
}

export function speechResult<T>(operation: () => Promise<T>): Promise<SpeechResult<T>> {
  return operation().then(
    (value) => ({ ok: true, value }),
    (cause: unknown) => ({
      ok: false,
      error: speechIpcError(cause)
    })
  )
}

function speechIpcError(cause: unknown): SpeechError {
  if (cause instanceof SpeechQueueError) return cause.speechError
  const message = cause instanceof Error ? cause.message : String(cause)
  const normalized = message.toLowerCase()
  const code: SpeechError['code'] =
    cause instanceof RangeError
      ? 'invalid-request'
      : normalized.includes('stale')
        ? 'capture-session-stale'
        : normalized.includes('disk space')
          ? 'insufficient-disk'
          : normalized.includes('checksum')
            ? 'checksum-mismatch'
            : normalized.includes('not qualified')
              ? 'model-not-qualified'
              : normalized.includes('not installed')
                ? 'model-unavailable'
                : normalized.includes('incompatible')
                  ? 'model-incompatible'
                  : normalized.includes('not found')
                    ? 'not-found'
                    : normalized.includes('cancel')
                      ? 'cancelled'
                      : normalized.includes('download')
                        ? 'download-failed'
                        : 'backend-failed'
  return { code, message, retryable: code !== 'invalid-request' && code !== 'model-incompatible' }
}
