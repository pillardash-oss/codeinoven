/**
 * How many pawn runs one account may have in flight at once.
 *
 * A provider's rate limit is per account, not per thread, and every pawn starts
 * its own request. Eleven pawns spawned onto one account in one turn is how a
 * working plan became eleven `429 rate_limit_error` threads in six seconds: ten
 * of them never ran a single step, and the person then had eleven failed runs to
 * read, retry or clean up.
 *
 * Three leaves room for the spawning thread's own turn and one retry beside it.
 * Past that, a spawn is refused with instructions instead of started and failed:
 * a refusal costs the agent one tool call, while a 429 costs the user a morning.
 */
export const MAX_PARALLEL_PAWN_RUNS_PER_ACCOUNT = 3

/**
 * Why this spawn must not start, or null when the account has room.
 *
 * Pure so the rule can be tested without a database: the count is supplied by
 * the caller, which reads it from the threads the app already tracks.
 */
export function pawnAdmissionRefusal(input: {
  running: number
  harnessId: string
  accountId?: string
  limit?: number
}): string | null {
  const limit = input.limit ?? MAX_PARALLEL_PAWN_RUNS_PER_ACCOUNT
  if (input.running < limit) return null
  const account = input.accountId ? `account ${input.accountId}` : 'the default account'
  return [
    `This account (${account} on ${input.harnessId}) is already running ${input.running} pawn agents, and its limit is ${limit} at a time.`,
    'A rate limit belongs to the account, so one more parallel spawn is what turns into a run that fails before it starts.',
    'Do this instead: spawn fewer pawns at once, wait for a running pawn to finish, or spread the work across accounts by naming a different `account_id` (or another `oven`) on this spawn.',
    'Nothing was spawned and no thread was created.'
  ].join(' ')
}
