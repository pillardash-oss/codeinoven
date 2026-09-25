/**
 * Scope display names are how a scope is addressed by reference, not just how it
 * is labelled: the scope tool resolves a reference by id first and then by
 * case-insensitive display name, and refuses an ambiguous one
 * (`src/main/workspaces/scope-tool/scope-tool-resolution.ts:29`). Two scopes
 * sharing a name therefore make every name-based reference unusable, so any
 * name the app invents for a user is uniquified against the board first.
 */

/** Comparison form: scope lookups trim and lowercase, so collisions must too. */
function comparisonKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * A scope name that collides with nothing already taken.
 *
 * The base is used verbatim when free. Otherwise a numeric suffix is appended
 * and incremented until the name is free, matching the `Name 2` form the app
 * already uses for repeated worker and auditor names.
 */
export function uniqueScopeName(taken: Iterable<string>, base: string): string {
  const used = new Set<string>()
  for (const name of taken) used.add(comparisonKey(name))
  const preferred = base.trim() || 'Scope'
  if (!used.has(comparisonKey(preferred))) return preferred
  let suffix = 2
  while (used.has(comparisonKey(`${preferred} ${suffix}`))) suffix += 1
  return `${preferred} ${suffix}`
}
