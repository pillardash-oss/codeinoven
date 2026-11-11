/**
 * The scope checkout a preview URL names, and the rule for accepting one.
 *
 * A scoped project's files live in its managed worktree rather than in the
 * project's own directory, and an `appfile://` preview is resolved from its URL
 * alone. So the scope has to travel with the URL: without it the request is
 * answered from the project root, where the file is not, and an image, PDF or
 * audio track inside a scope previews as nothing at all.
 *
 * Pure, with no `node:` import, so the protocol handler and its test read the
 * same rule. The id is an app-issued slug, and a malformed one is refused rather
 * than ignored: falling back to the project root would serve the wrong file
 * instead of failing honestly.
 */

const SCOPE_BUCKET_PATTERN = /^[a-zA-Z0-9._-]+$/u

/** Query parameter that carries the scope bucket on a preview URL. */
export const PREVIEW_SCOPE_PARAM = 'scope'

/**
 * `undefined` when the URL names no scope, the scope when it names a valid one,
 * and `null` when it names one this app would never issue.
 */
export function previewScope(url: Pick<URL, 'searchParams'>): string | undefined | null {
  const scope = url.searchParams.get(PREVIEW_SCOPE_PARAM)
  if (scope === null || scope === '') return undefined
  return SCOPE_BUCKET_PATTERN.test(scope) ? scope : null
}
