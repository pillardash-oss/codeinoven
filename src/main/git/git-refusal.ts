import type { GitSyncOutcome, GitSyncResult } from '../../lib/types'

/**
 * A git action that git refused in a state the user can resolve by acting:
 * an uncommitted working tree, a detached HEAD, a peer that cannot receive
 * commits, an integration still open. The message is the sentence the UI shows,
 * so a refusal is never a candidate for a generic "something failed" fallback.
 *
 * Distinct from an ordinary `Error` because the transport layers must not hand
 * it to the renderer as a rejected IPC invoke: Electron logs every rejected
 * `ipcMain.handle` call with `console.error`, which would broadcast a refusal
 * the panel already renders in its own dialog. `gitSyncOutcome` turns it into
 * data instead.
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
 * git's own wordings for "local changes are in the way". Both integration
 * paths phrase the refusal themselves because git names the mechanism (a
 * rebase, a merge, an overwrite) where the user needs the file count and what
 * to do with it. Matched against git's text because a merge can legitimately
 * carry local changes through, so refusing every dirty checkout up front would
 * block syncs git would have completed.
 */
const UNCOMMITTED_CHANGES_REFUSALS = [
  'Please commit or stash them',
  'Please commit your changes or stash them',
  'would be overwritten by merge',
  'cannot pull with rebase',
  'You have unstaged changes'
] as const

/** Whether a git failure is git refusing to touch local uncommitted changes. */
export function isUncommittedChangesRefusal(failure: unknown): boolean {
  const message = failure instanceof Error ? failure.message : String(failure)
  return UNCOMMITTED_CHANGES_REFUSALS.some((wording) => message.includes(wording))
}

/**
 * Run a sync for a renderer-facing channel, reporting a refusal as data.
 *
 * Any other failure still rejects: an unexpected error is exactly what the
 * renderer's `catch` fallback is for, and it must stay visible in the log.
 */
export async function gitSyncOutcome(run: () => Promise<GitSyncResult>): Promise<GitSyncOutcome> {
  try {
    return { ok: true, result: await run() }
  } catch (failure) {
    if (isGitRefusal(failure)) return { ok: false, refusal: failure.message }
    throw failure
  }
}
