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

export function checkpointForTurn(
  messages: readonly AgentMessage[],
  checkpoints: readonly TurnCheckpointSummary[],
  messageIndex: number
): TurnCheckpointSummary | null {
  const assistant = messages[messageIndex]
  if (!assistant || assistant.role !== 'assistant') return null

  const completed = checkpoints.filter(isCompleted)
  let owner: TurnCheckpointSummary | null = null
  for (const checkpoint of completed) {
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

/** True when `messageIndex` is the final assistant message of `checkpoint`'s
 *  turn — the single place its file card should render. Keeps a card from
 *  being drawn multiple times when mid-turn question-answer user messages
 *  split the visual turn into several `isTurnEnd` boundaries. */
export function isCheckpointTurnEnd(
  messages: readonly AgentMessage[],
  checkpoint: TurnCheckpointSummary,
  messageIndex: number
): boolean {
  const start = checkpoint.createdAt - CHECKPOINT_START_TOLERANCE_MS
  const end = checkpoint.completedAt ?? checkpoint.createdAt
  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]
    if (candidate?.role !== 'assistant') continue
    if (candidate.createdAt >= start && candidate.createdAt <= end) return false
  }
  return true
}
