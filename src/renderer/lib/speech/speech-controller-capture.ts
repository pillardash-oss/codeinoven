export type RecordingFailurePhase = 'prepare' | 'permission' | 'capture' | 'transcription'

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'] as const
// Chunk the stream for bounded IPC and disk writes. There is intentionally no
// elapsed-time cap on a recording; it ends only when the user stops it or the
// capture device/storage reports a real failure.
export const CAPTURE_TIMESLICE_MS = 250
export const PAUSE_UPLOAD_DEPTH = 4
export const CAPTURE_STOP_TIMEOUT_MS = 5_000
/**
 * Bound on how long the microphone may take to open before the attempt is
 * settled as failed. Without it a wedged audio device leaves the surface in
 * `starting` forever, where `stop()` and Escape are both no-ops because no
 * `ActiveCapture` exists yet.
 */
export const CAPTURE_START_TIMEOUT_MS = 10_000
/**
 * Bound on draining the serialized chunk-upload chain when a recording stops.
 * One chunk write that never resolves must not pin `stopping` (and block every
 * later stop) for the lifetime of the app.
 */
export const CAPTURE_UPLOAD_DRAIN_TIMEOUT_MS = 5_000

export function errorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message
  if (typeof cause === 'string' && cause.trim()) return cause
  return 'Unknown recording error.'
}

export function selectedMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  return MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

export function recordingToastMessage(cause: unknown, phase: RecordingFailurePhase): string {
  const name =
    typeof DOMException !== 'undefined' && cause instanceof DOMException ? cause.name : ''
  if (phase === 'prepare') return 'Focus the editor before recording.'
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Microphone access is blocked.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is unavailable.'
  }
  if (phase === 'transcription') return 'Voice recording could not be transcribed.'
  return 'Voice recording failed.'
}
