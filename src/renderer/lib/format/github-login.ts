/**
 * How a GitHub account name reads in the UI.
 *
 * An app account's login carries a `[bot]` suffix (`pullfrog[bot]`,
 * `dependabot[bot]`) because that is how GitHub disambiguates it from a user of
 * the same name. It is part of the login, not part of the name, and every surface
 * that shows one also shows GitHub's own `Bot` badge right beside it
 * (`PrCommentActionsMenu`, the comment header, the PR identity row), so printing
 * the suffix as well says the same thing twice in the space of one word.
 *
 * Keep the raw login for anything that is not display text: it is the value the
 * API and the avatar CDN are keyed by, and `pullfrog` is a different account from
 * `pullfrog[bot]`.
 */
export function githubDisplayLogin(login: string | null | undefined): string {
  if (!login) return ''
  return login.endsWith('[bot]') ? login.slice(0, -'[bot]'.length) : login
}
