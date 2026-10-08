/**
 * Whether an account label is one the app generated rather than one the user typed.
 *
 * Shared because both ends of the app have to agree on the answer: the main process
 * writes labels and must recognise its own generated ones when it reconciles, and
 * the renderer has to know whether showing a label on a single account is telling
 * the user something or repeating the provider name back at them. Two copies of
 * this pattern would drift, and the failure would be silent: a label the user typed
 * would quietly stop being treated as theirs.
 */

/** Escape a value for literal use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Whether `label` is the generated label for `base`, which is `<base>-<n>`.
 *
 * A base with no text is never a match, because every label would be `<empty>-<n>`
 * and an account with no provider name has nothing for the shape to key off.
 */
export function isGeneratedAccountLabel(label: string, base: string): boolean {
  if (!base.trim()) return false
  return new RegExp(`^${escapeRegExp(base)}-\\d+$`, 'iu').test(label)
}

/**
 * Whether an account's label is the generated one, judged against every base that
 * could have produced it.
 *
 * The base is whichever name was known when the row was written, so a row created
 * while only the provider id was known carries a label derived from that id. Testing
 * all three is what keeps such a label from being mistaken for a hand-typed one.
 */
export function isGeneratedAccountLabelFor(
  label: string,
  bases: ReadonlyArray<string | undefined>
): boolean {
  return bases.some((base) => base !== undefined && isGeneratedAccountLabel(label, base))
}
