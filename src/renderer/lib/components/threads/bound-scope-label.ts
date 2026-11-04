import { abbreviatedScopeName } from '$lib/threads/thread-scope'
import type { BoundScopeRebind } from '$shared/types'

/**
 * The scope line an assistant row wears, and the rule that it never repeats the
 * project.
 *
 * An assistant sidebar already states the assistant, the task and its schedule.
 * Repeating the project name on every bound row of the same project spends the
 * row's narrowest space on something the user can already see in the scope name
 * and the checkout, so the row shows the short scope name only.
 *
 * Unbound tasks show nothing at all: an empty placeholder would read as "no
 * scope" on every ordinary task, which is the state almost all of them are in.
 */
export interface AssistantRowScopeInput {
  boundScope?: BoundScopeRebind
  /** The scope's display name from its board, when the board is loaded. */
  bucketName?: string
}

export function assistantRowScopeLabel(input: AssistantRowScopeInput): string | null {
  if (!input.boundScope) return null
  const name = input.bucketName?.trim()
  // A board that has not loaded yet still names something real: the scope id is
  // the identity the run resolves, so showing it beats showing nothing.
  return abbreviatedScopeName(name && name.length > 0 ? name : input.boundScope.scopeBucketId)
}

/**
 * A parked run's line, in the app's own scope wording rather than a new string.
 *
 * `cause` comes from the shared health guidance, so the row, the scope card and
 * the resolver's error all say the same thing about the same failure.
 */
export function parkedRunLine(cause: string): string {
  return `Parked: ${cause}`
}
