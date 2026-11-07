/** The Engineering artifact a tool started whose generation is still running. */
export type EngineeringGenerationStage = 'spec' | 'assignment' | null

/**
 * Whether the header's Engineering studio control is offered.
 *
 * A tool call can start a stage minutes before its document exists, so the
 * control must already be there while generation runs; otherwise an agent that
 * initiates a spec or Assignment by itself leaves the reader with no way to look
 * at the work in progress.
 */
export function engineeringStudioVisible(input: {
  chatMode: boolean
  hasDocument: boolean
  retryable: boolean
  generationInFlight: EngineeringGenerationStage
}): boolean {
  if (input.chatMode) return false
  return input.hasDocument || input.retryable || input.generationInFlight !== null
}

/**
 * What the studio says while a tool-started artifact is still being generated.
 *
 * There is deliberately no document to show in this window: saying the agent is
 * still working is the honest answer, and it never pretends a draft exists.
 */
export function engineeringPendingMessage(stage: EngineeringGenerationStage): string | null {
  if (stage === 'assignment') {
    return 'The agent is preparing the Assignment. Nothing has been generated yet, and it is still working.'
  }
  if (stage === 'spec') {
    return 'The agent is preparing the specification. Nothing has been generated yet, and it is still working.'
  }
  return null
}
