/**
 * Maximum user-facing failure text persisted on (and rendered from) a turn
 * checkpoint. A checkpoint failure is a short explanation (interruption notice,
 * capture warning, contract rejection)   never a transcript. The bound also
 * heals legacy checkpoints: before the textual usage-limit detection was
 * structurally guarded, an agent's entire final message could be recorded as
 * the failure and then splash into the run-changes card verbatim.
 */
export const MAX_CHECKPOINT_FAILURE_LENGTH = 600

/** Bound a checkpoint's user-facing failure text to a short explanation. */
export function boundCheckpointFailure(failure: string): string {
  const trimmed = failure.trim()
  if (trimmed.length <= MAX_CHECKPOINT_FAILURE_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_CHECKPOINT_FAILURE_LENGTH).trimEnd()}…`
}

export function assertId(value: string): void {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error(`Unsafe checkpoint identifier: ${value}`)
}
