import type { GitRemoteUpdate } from '../../../lib/types'

/**
 * Reading the moment a commit reached the remote.
 *
 * A commit object carries no push date: `%aI` and `%cI` are when it was written
 * and committed, not when it was published, and GitHub's API has no per-commit
 * push time either. Git's reflog for the remote-tracking ref is the one native
 * record that does, because git writes a line every time that ref moves and
 * stamps it with the moment it moved. The message distinguishes the movements
 * that matter: `update by push` is this checkout publishing a batch, and
 * anything else (a fetch, a pull, a clone) is us learning that a batch was
 * already there.
 *
 * The reflog is what makes push batches visible: consecutive commits that left
 * in one push share an entry, and the next entry up marks where the following
 * push began.
 *
 * Limits worth knowing: reflog entries expire (`gc.reflogExpire`, 90 days by
 * default) and only this clone's own activity is recorded, so a batch pushed
 * from another machine shows up as `received` on the next fetch rather than as
 * a push. Both cases degrade to "older than the oldest update we still know".
 */

/**
 * `%H` is the value the ref took, `%gD` carries the selector with a date under
 * `--date=iso-strict`, and `%gs` is git's own message for the movement.
 *
 * The unit separator keeps the three fields apart: a reflog message is a
 * command line or a free-form subject and can contain any printable character.
 */
export const REMOTE_UPDATE_FORMAT = '%H%x1f%gD%x1f%gs'

/** Entries one read returns. A long-lived clone's reflog grows without bound. */
export const REMOTE_UPDATE_LIMIT = 100

/** git's reflog message for a remote-tracking ref that a push moved. */
const PUSH_REFLOG_MESSAGE = 'update by push'

/**
 * Only refs under this prefix are remote-tracking. A branch set to track a
 * *local* branch (`branch.<name>.remote = .`) sits under `refs/heads/`, and its
 * reflog records ordinary commits, which are not pushes.
 */
export const REMOTE_REF_PREFIX = 'refs/remotes/'

/** `refs/remotes/origin/main@{2026-09-18T08:35:11+01:00}` */
const SELECTOR_DATE_PATTERN = /@\{(?<date>[^}]*)\}$/u

/** `push` when this checkout moved the ref, `received` for every other movement. */
export function classifyRemoteUpdate(message: string): GitRemoteUpdate['kind'] {
  return message.startsWith(PUSH_REFLOG_MESSAGE) ? 'push' : 'received'
}

/** The epoch ms inside a reflog selector, or null if git's date is unreadable. */
export function parseRemoteUpdateDate(selector: string): number | null {
  const date = SELECTOR_DATE_PATTERN.exec(selector)?.groups?.date
  if (date === undefined || date === '') return null
  const timestamp = Date.parse(date)
  return Number.isFinite(timestamp) ? timestamp : null
}

/**
 * Map `git reflog show` output for one remote-tracking ref to updates, newest
 * first, in the order git reports them. A line missing a field is skipped rather
 * than guessed at, so a reflog written by an unexpected git version cannot
 * produce an update pointing at nothing.
 */
export function parseRemoteUpdates(ref: string, raw: string): GitRemoteUpdate[] {
  const updates: GitRemoteUpdate[] = []
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue
    const [sha, selector, message] = line.split('\u001f')
    if (!sha || !selector || message === undefined) continue
    updates.push({
      ref,
      sha,
      at: parseRemoteUpdateDate(selector),
      kind: classifyRemoteUpdate(message),
      message
    })
  }
  return updates
}
