import type { PermissionLevel } from './types/common'

/**
 * The mode `PermissionPolicy` evaluates a permission request with.
 *
 * It is declared here, next to {@link permissionPolicyMode}, so both the main
 * process and the renderer can name it without reaching across the process
 * boundary; `src/main/permissions/permission-policy.ts` re-exports it as its
 * own type.
 */
export type PermissionPolicyMode = 'auto_review' | 'full_access' | 'oven_mode'

/**
 * Whether the level is Oven Mode.
 *
 * Oven Mode is the highest level and exists only for a thread whose composer is
 * set to an external Oven (a remote machine) before the message is sent. The
 * agent may need to do anything on that machine to finish the task, so in this
 * mode every protective check is off: the sensitive-file block list, the
 * bundled-pi file policy, protected path patterns, `restrictToAllowed`, and the
 * workspace-root rules. Every request is approved and no card is ever raised
 * for a policy reason. It is strictly more permissive than `full_access`, which
 * still honors the sensitive-file block list.
 */
export function isOvenMode(level: PermissionLevel | undefined | null): boolean {
  return level === 'oven_mode'
}

/**
 * Whether the level has granted the agent everything: `full_access` or, above
 * it, `oven_mode`.
 *
 * Use this wherever a comparison means "the user granted everything"   the
 * danger tier of a harness sandbox, an approval bridge that would never be
 * answered, a browser mutation that needs no review. Do not use it where the
 * comparison means something narrower than a blanket grant (for example "this
 * thread is in Auto Review", which Oven Mode is not).
 */
export function isUnrestrictedLevel(level: PermissionLevel | undefined | null): boolean {
  return level === 'full_access' || level === 'oven_mode'
}

/**
 * The policy mode one level evaluates with, falling back to `auto_review` for a
 * level this build does not know so an unreadable value can only ever be the
 * cautious one.
 *
 * Oven Mode keeps its own mode instead of collapsing into `full_access`: the
 * policy already treats it exactly like Full Access apart from the protection
 * that Full Access still applies, so mapping it down would put the
 * sensitive-file card back.
 */
export function permissionPolicyMode(
  level: PermissionLevel | undefined | null
): PermissionPolicyMode {
  return level === 'full_access' || level === 'oven_mode' ? level : 'auto_review'
}
