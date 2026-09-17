/**
 * GitHub reference linkification for markdown authored on GitHub.
 *
 * Text written in a pull request, issue, or comment can reference a pull
 * request (`#150`), a cross-repository issue (`owner/repo#150`), a commit
 * reference (`GH-150`), or a user (`@login`). On github.com those become
 * links; this module produces the same links for the app's markdown pipeline.
 *
 * All linkification happens inside marked inline tokenizers. Pre-processing
 * the raw source with regexes would corrupt code spans and fenced blocks; a
 * tokenizer is never asked to lex inside either of them.
 *
 * There is no SvelteKit dependency here   the URL builders and the extension
 * factory are plain TypeScript and can be imported from anywhere.
 */
import type { Token, Tokens, TokensList, TokenizerAndRendererExtension } from 'marked'

/** Repository the rendered content lives in. */
export interface GithubRepoContext {
  owner: string
  repo: string
}

// ─── URL builders ───────────────────────────────────────────────────────────
// Kept first and dependency-free: other features link to GitHub too and only
// need a correctly encoded URL, not the markdown extension below.

/** Pull request page for `owner/repo`. */
export function githubPullRequestUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pull/${encodeURIComponent(String(number))}`
}

/** Issue page for `owner/repo`. GitHub redirects this to the pull request
 *  when the number is one, which is why plain `#N` references use it. */
export function githubIssueUrl(owner: string, repo: string, number: number): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${encodeURIComponent(String(number))}`
}

/** Profile page for a login. */
export function githubUserUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}`
}

/** New-issue composer, optionally prefilled with a body. */
export function githubNewIssueUrl(owner: string, repo: string, body?: string): string {
  const base = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/new`
  return body ? `${base}?body=${encodeURIComponent(body)}` : base
}

/** GitHub's abuse-report form. */
export function githubAbuseReportUrl(): string {
  return 'https://github.com/contact/report-abuse'
}

/** Blocked-users settings, optionally prefilled with the user to block. */
export function githubBlockUserUrl(login?: string): string {
  const base = 'https://github.com/settings/blocked_users'
  return login ? `${base}?blocked_user=${encodeURIComponent(login)}` : base
}

// ─── Reference extension ────────────────────────────────────────────────────

/** Token type emitted for every resolved reference. */
export const GITHUB_REFERENCE_TOKEN = 'githubReference'

export type GithubReferenceKind = 'issue' | 'crossRepoIssue' | 'user'

export interface GithubReferenceToken extends Tokens.Generic {
  type: typeof GITHUB_REFERENCE_TOKEN
  kind: GithubReferenceKind
  href: string
  text: string
}

// Owner names are alphanumeric with inner hyphens; repository names also allow
// `_` and `.`. The cross-repo form ends in the same `#N` an issue reference
// does, so its tokenizer must run before the plain issue one.
const CROSS_REPO_PATTERN = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+)#(\d+)/
const ISSUE_PATTERN = /^#(\d+)/
const COMMIT_PATTERN = /^GH-(\d+)/i
const USER_PATTERN = /^@([A-Za-z0-9-]+)/

// Unanchored mirrors of the tokenizers, used by `start` to find the next
// candidate. They must stay in sync with the patterns above, otherwise `start`
// either stops too early (dead split) or skips a real reference (missed link).
const CROSS_REPO_SEARCH = /[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+#\d+/g
const ISSUE_SEARCH = /#\d+/g
const COMMIT_SEARCH = /GH-\d+/gi
const USER_SEARCH = /@[A-Za-z0-9-]+/g

// Characters that make a reference part of a larger token instead of a
// standalone one. `&` keeps HTML entities (`&#150;`) out; `/` keeps the `#N`
// inside `owner/repo#N` from being claimed twice; `.`, `_`, `-` are all valid
// inside the owner/repo/login tokens we would otherwise cut in half.
const CROSS_REPO_BLOCKED_PRECEDING = /[0-9A-Za-z_./-]/
const ISSUE_BLOCKED_PRECEDING = /[0-9A-Za-z_/&#]/
const COMMIT_BLOCKED_PRECEDING = /[0-9A-Za-z_-]/
// The tokenizer only enforces what GitHub documents (word character or `/`).
// `start` is stricter   it also refuses `.`, `+` and `-`   so an email
// (`foo.bar+baz@example.com`) is never split before marked's own URL tokenizer
// gets its turn. Without that, mid-sentence emails would stop being mailto
// links because the text chunk before them was cut short.
const USER_BLOCKED_PRECEDING = /[0-9A-Za-z_/]/
const USER_START_BLOCKED_PRECEDING = /[0-9A-Za-z._+/-]/

/**
 * Next match of `pattern` whose preceding character is not in `blocked`.
 *
 * `pattern` carries the `g` flag so a rejected match does not hide a later
 * one; `lastIndex` is reset first so nested lexer runs cannot leak scan state.
 * A match at index 0 has no visible preceding character   marked slices the
 * first character off `src` before calling `start`   so it is surfaced and the
 * tokenizer's own check decides.
 */
function nextCandidate(src: string, pattern: RegExp, blocked: RegExp): number | undefined {
  pattern.lastIndex = 0
  let match = pattern.exec(src)
  while (match) {
    const index = match.index
    if (index === 0 || !blocked.test(src[index - 1])) return index
    pattern.lastIndex = index + 1
    match = pattern.exec(src)
  }
  return undefined
}

function earliest(indices: Array<number | undefined>): number | undefined {
  let best: number | undefined
  for (const index of indices) {
    if (index === undefined) continue
    if (best === undefined || index < best) best = index
  }
  return best
}

/** Last character of the previously emitted inline text token, if any. */
function lastTextChar(tokens: Token[] | TokensList): string | null {
  const previous = tokens.length > 0 ? tokens[tokens.length - 1] : undefined
  if (!previous || previous.type !== 'text') return null
  const text = (previous as Tokens.Text).text
  return text.length > 0 ? text.slice(-1) : null
}

function precededBy(tokens: Token[] | TokensList, blocked: RegExp): boolean {
  const previous = lastTextChar(tokens)
  return previous !== null && blocked.test(previous)
}

function referenceToken(
  kind: GithubReferenceKind,
  href: string,
  text: string
): GithubReferenceToken {
  return { type: GITHUB_REFERENCE_TOKEN, raw: text, kind, href, text }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Build the repo-scoped inline extension.
 *
 * Every rendered anchor is a plain `<a href="...">` with the visible text
 * preserved: DOMPurify in the markdown pipeline adds `target`/`rel` itself, so
 * adding them here would only be overwritten.
 *
 * `owner/repo#N` is linked even when it names the context repository. GitHub
 * does the same, and the resulting URL is identical to the same-repo one, so
 * the "only when it differs" rule is a distinction with no observable effect.
 */
export function githubReferencesExtension(
  context: GithubRepoContext
): TokenizerAndRendererExtension {
  return {
    name: 'githubReference',
    level: 'inline',
    start(src: string): number | undefined {
      // Never split link text: references inside a link must not nest anchors.
      if (this.lexer.state.inLink) return undefined
      return earliest([
        nextCandidate(src, CROSS_REPO_SEARCH, CROSS_REPO_BLOCKED_PRECEDING),
        nextCandidate(src, ISSUE_SEARCH, ISSUE_BLOCKED_PRECEDING),
        nextCandidate(src, COMMIT_SEARCH, COMMIT_BLOCKED_PRECEDING),
        nextCandidate(src, USER_SEARCH, USER_START_BLOCKED_PRECEDING)
      ])
    },
    tokenizer(src: string, tokens: Token[] | TokensList): Tokens.Generic | undefined {
      // marked lexes a link's text recursively while `inLink` is set. A mention
      // there would render an anchor inside an anchor.
      if (this.lexer.state.inLink) return undefined

      // Cross-repo first: it owns the whole `owner/repo#N`, including the `#`
      // that the issue rule would otherwise claim with a word character before
      // it (and therefore reject anyway).
      const crossRepo = CROSS_REPO_PATTERN.exec(src)
      if (crossRepo && !precededBy(tokens, CROSS_REPO_BLOCKED_PRECEDING)) {
        const [, owner, repo, number] = crossRepo
        return referenceToken(
          'crossRepoIssue',
          githubIssueUrl(owner, repo, Number(number)),
          crossRepo[0]
        )
      }

      const issue = ISSUE_PATTERN.exec(src)
      if (issue && !precededBy(tokens, ISSUE_BLOCKED_PRECEDING)) {
        return referenceToken(
          'issue',
          githubIssueUrl(context.owner, context.repo, Number(issue[1])),
          issue[0]
        )
      }

      const commit = COMMIT_PATTERN.exec(src)
      if (commit && !precededBy(tokens, COMMIT_BLOCKED_PRECEDING)) {
        return referenceToken(
          'issue',
          githubIssueUrl(context.owner, context.repo, Number(commit[1])),
          commit[0]
        )
      }

      const user = USER_PATTERN.exec(src)
      if (user && !precededBy(tokens, USER_BLOCKED_PRECEDING)) {
        return referenceToken('user', githubUserUrl(user[1]), user[0])
      }

      return undefined
    },
    renderer(token: Tokens.Generic): string {
      const reference = token as GithubReferenceToken
      return `<a href="${escapeHtml(reference.href)}">${escapeHtml(reference.text)}</a>`
    }
  }
}
