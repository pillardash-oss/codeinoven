import type { GitInvocation } from '../../lib/types'

/**
 * A git action that git refused in a state the user can resolve by acting:
 * an uncommitted working tree, a detached HEAD, a peer that cannot receive
 * commits, an integration still open, a branch that is not fully merged. The
 * message is the sentence the UI shows, so a refusal is never a candidate for a
 * generic "something failed" fallback.
 *
 * Distinct from an ordinary `Error` because the renderer-facing transports must
 * not hand it over as a rejected invoke: Electron logs every rejected
 * `ipcMain.handle` call with `console.error`, which would broadcast to the log a
 * refusal the panel already renders. `gitInvocation` turns it into data.
 */
export class GitRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitRefusal'
  }
}

export function isGitRefusal(value: unknown): value is GitRefusal {
  return value instanceof GitRefusal
}

/**
 * git refusing to touch local uncommitted changes. A rebase refuses any tracked
 * change outright; a checkout and a merge refuse only when a local change would
 * be overwritten, which only git can decide, so the wording is what identifies
 * it. Both integration paths report this one themselves with the file count it
 * is about, and this list catches the rest.
 */
const WORKING_TREE_REFUSALS = [
  'please commit or stash them',
  'please commit your changes or stash them',
  'you have unstaged changes',
  'your index contains uncommitted changes',
  'would be overwritten by checkout',
  'would be overwritten by merge',
  'would be overwritten by rebase',
  'cannot rebase',
  'cannot pull with rebase'
] as const

/**
 * An integration git left open, which blocks the next one.
 *
 * Spelled out per git's own phrasings rather than one loose word: an open merge
 * and a stopped rebase answer differently, and each sentence is what the panel
 * turns into "finish or abort it first".
 */
const INTEGRATION_REFUSALS = [
  'not concluded your merge',
  'unfinished merge',
  'rebase-merge directory',
  'you are in the middle of another rebase'
] as const

/** A branch git considers already taken, or unreachable so it will not delete it. */
const BRANCH_REFUSALS = ['a branch named', 'is not fully merged'] as const

/**
 * A push git refuses to fast-forward, or a branch with nowhere to push it. These
 * are the wordings the store already classifies through `isPushRejected`, so the
 * two stay in step instead of one drifting from the other.
 */
const PUSH_REFUSALS = [
  'non-fast-forward',
  'fetch first',
  'updates were rejected',
  'failed to push some refs',
  'has no upstream branch'
] as const

/**
 * Every wording that means "the repository is in a state you have to resolve
 * first". Matched against git's text because the alternative is refusing every
 * dirty checkout up front, which would block operations git would have
 * completed. Compared lowercased, because git capitalizes these sentences
 * differently across releases (`A branch named` before 2.40, `a branch named`
 * after).
 */
const STATE_REFUSALS: readonly string[] = [
  ...WORKING_TREE_REFUSALS,
  ...INTEGRATION_REFUSALS,
  ...BRANCH_REFUSALS,
  ...PUSH_REFUSALS
]

function matchesAny(message: string, wordings: readonly string[]): boolean {
  const normalized = message.toLowerCase()
  return wordings.some((wording) => normalized.includes(wording))
}

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

/** Whether a failure is git refusing because of the repository's own state. */
export function isGitStateRefusal(failure: unknown): boolean {
  return isGitRefusal(failure) || matchesAny(failureMessage(failure), STATE_REFUSALS)
}

/**
 * Whether a failure is git refusing to touch local uncommitted changes, the
 * subset an integration answers with the file count it is about. Narrower than
 * `isGitStateRefusal` on purpose: the sync path only folds a refusal into its own
 * sentence when the working tree is the reason.
 */
export function isUncommittedChangesRefusal(failure: unknown): boolean {
  return matchesAny(failureMessage(failure), WORKING_TREE_REFUSALS)
}

/**
 * Run a refusing git channel, reporting an expected refusal as data.
 *
 * Any other failure still rejects: an unexpected error is exactly what the
 * renderer's `catch` fallback is for, and it must stay visible in the log.
 */
export async function gitInvocation<Value>(
  run: () => Promise<Value>
): Promise<GitInvocation<Value>> {
  try {
    return { ok: true, value: await run() }
  } catch (failure) {
    if (isGitStateRefusal(failure)) return { ok: false, refusal: failureMessage(failure) }
    throw failure
  }
}
