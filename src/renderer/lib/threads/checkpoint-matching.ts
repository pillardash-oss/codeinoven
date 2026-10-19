import type { AgentMessage, TurnCheckpointSummary } from '$shared/types'

/**
 * Small tolerance for the checkpoint start edge. Assistant messages are
 * produced after `beginTurn` creates the checkpoint, but message and checkpoint
 * timestamps come from different clocks/sources, so allow a tiny skew without
 * letting the next turn's checkpoint steal the previous turn's final message.
 */
const CHECKPOINT_START_TOLERANCE_MS = 100

function isCompleted(checkpoint: TurnCheckpointSummary): boolean {
  return checkpoint.status !== 'active'
}

/**
 * The completed checkpoint whose window contains this assistant message, or
 * null. Called once per message whenever the transcript index is rebuilt, so it
 * scans without allocating: skipping the active checkpoints inline replaces the
 * per-call `checkpoints.filter(...)` copy the render path used to pay once per
 * mounted message on every publish.
 */
export function checkpointForTurn(
  messages: readonly AgentMessage[],
  checkpoints: readonly TurnCheckpointSummary[],
  messageIndex: number
): TurnCheckpointSummary | null {
  const assistant = messages[messageIndex]
  if (!assistant || assistant.role !== 'assistant') return null

  let owner: TurnCheckpointSummary | null = null
  for (const checkpoint of checkpoints) {
    if (!isCompleted(checkpoint)) continue
    const end = checkpoint.completedAt ?? checkpoint.createdAt
    if (
      assistant.createdAt >= checkpoint.createdAt - CHECKPOINT_START_TOLERANCE_MS &&
      assistant.createdAt <= end
    ) {
      if (!owner || checkpoint.createdAt > owner.createdAt) owner = checkpoint
    }
  }
  return owner
}
