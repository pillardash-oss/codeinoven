/**
 * The prompt a retried Assignment draft sends into its preserved session.
 *
 * It never re-states the task: the session already holds the specification, the
 * repository reads and the analysis, which is the whole point of continuing it.
 * The turn only has to finish the shape the app can store.
 *
 * A rejected answer is the case that made this prompt worth owning: a validator
 * refused the graph for a concrete reason (parallel tasks claiming one file, a
 * task naming an unknown phase), and a continuation that did not carry that
 * reason asked the model to solve the problem it had not been told about, so the
 * retry produced the same graph and failed the same way.
 */

/** What to do about a refusal, in the validator's own terms. */
const REJECTION_GUIDANCE =
  'Fix exactly those problems. Two tasks that do not depend on each other may not claim the same expected file: give the tasks separate files, or make one task depend on the other.'

/** The JSON shape one finished draft has to have. */
const DRAFT_SHAPE =
  '{"title": string, "summary": string, "phases": [{"id": string, "title": string, "description": string}], "tasks": [{"id": string, "phaseId": string, "title": string, "description": string, "prompt": string, "owner": "senior" | "worker", "dependsOn": string[], "expectedFiles": string[], "auditChecklist": string[]}]}'

/**
 * Build the continuation prompt, carrying the validator's refusal when the
 * previous answer for this thread was refused.
 */
export function assignmentContinuationPrompt(rejected?: string): string {
  const refusal = rejected?.trim()
  return [
    'Continue the Assignment draft you were already writing in this session.',
    'Do not repeat your analysis, do not explain anything, and do not ask questions.',
    ...(refusal
      ? [
          'Your previous answer was rejected by the Assignment validator:',
          refusal,
          REJECTION_GUIDANCE
        ]
      : []),
    'Return only one complete JSON object shaped as:',
    DRAFT_SHAPE,
    'Every phase id a task names must exist in phases, and at least one phase and one task are required.'
  ].join('\n')
}

/**
 * The validator's refusal as a prompt block for a fresh run.
 *
 * A model the user switched to never saw the answer that was refused, so the
 * same words have to travel with the new request. Empty when nothing was
 * refused, so a first run never carries a phantom failure.
 */
export function assignmentRejectionBlock(rejected?: string): string {
  const refusal = rejected?.trim()
  if (!refusal) return ''
  return [
    'The previous answer for this Assignment was rejected by the Assignment validator:',
    refusal,
    REJECTION_GUIDANCE
  ].join('\n')
}
