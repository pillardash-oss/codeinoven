import { describe, expect, it } from 'vitest'
import { Marked } from 'marked'
import {
  githubAbuseReportUrl,
  githubAppInstallUrl,
  githubBlockUserUrl,
  githubIssueUrl,
  githubNewIssueUrl,
  githubPullRequestUrl,
  githubReferencesExtension,
  githubUserUrl
} from '$lib/github-references'
import { emojiForShortcode, githubEmojiExtension } from '$lib/components/markdown/github-emoji'

const CONTEXT = { owner: 'acme', repo: 'app' }

/** Render with the same two extensions the markdown pipeline registers. */
function render(markdown: string): string {
  const parser = new Marked({ gfm: true, breaks: true })
  parser.use({ extensions: [githubReferencesExtension(CONTEXT), githubEmojiExtension] })
  return parser.parser(parser.lexer(markdown))
}

describe('GitHub URL builders', () => {
  it('builds pull request, issue, and user URLs', () => {
    expect(githubPullRequestUrl('acme', 'app', 150)).toBe('https://github.com/acme/app/pull/150')
    expect(githubIssueUrl('acme', 'app', 150)).toBe('https://github.com/acme/app/issues/150')
    expect(githubUserUrl('octo-cat')).toBe('https://github.com/octo-cat')
  })

  it('percent-encodes every dynamic path segment', () => {
    expect(githubIssueUrl('a b/c', 'd?e', 7)).toBe('https://github.com/a%20b%2Fc/d%3Fe/issues/7')
    expect(githubUserUrl('a/b c')).toBe('https://github.com/a%2Fb%20c')
  })

  it('omits the body when none is given and encodes it otherwise', () => {
    expect(githubNewIssueUrl('acme', 'app')).toBe('https://github.com/acme/app/issues/new')
    expect(githubNewIssueUrl('acme', 'app', 'hi there & co')).toBe(
      'https://github.com/acme/app/issues/new?body=hi%20there%20%26%20co'
    )
  })

  it('points at the abuse form and the blocked-users settings', () => {
    expect(githubAbuseReportUrl()).toBe('https://github.com/contact/report-abuse')
    expect(githubBlockUserUrl()).toBe('https://github.com/settings/blocked_users')
    expect(githubBlockUserUrl('octo cat')).toBe(
      'https://github.com/settings/blocked_users?blocked_user=octo%20cat'
    )
  })

  it('points the install prompt at this app\u0027s GitHub App', () => {
    expect(githubAppInstallUrl()).toBe('https://github.com/apps/codeinoven/installations/new')
  })
})

describe('githubReferencesExtension', () => {
  it('linkifies a same-repo issue reference', () => {
    expect(render('Fixes #150')).toContain(
      '<a href="https://github.com/acme/app/issues/150">#150</a>'
    )
  })

  it('leaves a reference glued to a word alone', () => {
    expect(render('abc#150')).not.toContain('github.com/acme/app/issues/150')
  })

  it('linkifies a cross-repo reference to that repository, not the context one', () => {
    const html = render('See owner/repo#150')
    expect(html).toContain('https://github.com/owner/repo/issues/150')
    expect(html).not.toContain('https://github.com/acme/app/issues/150')
  })

  it('does not treat a URL fragment as a same-repo issue reference', () => {
    const html = render('https://x#1')
    expect(html).not.toContain('github.com/acme/app/issues/1')
    expect(html).toContain('href="https://x#1"')
  })

  it('linkifies GH-style references case-insensitively', () => {
    expect(render('GH-123')).toContain('https://github.com/acme/app/issues/123')
    expect(render('gh-456')).toContain('https://github.com/acme/app/issues/456')
  })

  it('linkifies mentions but not emails or URLs', () => {
    expect(render('Thanks @octo-cat')).toContain(
      '<a href="https://github.com/octo-cat">@octo-cat</a>'
    )
    expect(render('mail foo@bar.com')).not.toContain('https://github.com/bar')
    expect(render('https://example.com/@user')).not.toContain('https://github.com/user')
  })

  it('does not linkify references inside code spans or fences', () => {
    expect(render('`#150`')).not.toContain('https://github.com/acme/app/issues/150')
    expect(render('```\n#150\n```')).not.toContain('https://github.com/acme/app/issues/150')
  })
})

describe('github-emoji', () => {
  it('resolves lowercase shortcodes exactly', () => {
    expect(emojiForShortcode('wave')).toBe('👋')
    expect(emojiForShortcode('+1')).toBe('👍')
    expect(emojiForShortcode('shipit')).toBeNull()
    expect(emojiForShortcode('WAVE')).toBeNull()
  })

  it('expands a resolvable shortcode inline', () => {
    expect(render('hi :wave:')).toContain('<span class="emoji" data-emoji="wave">👋</span>')
  })

  it('keeps image-only shortcodes and clock-like colons literal', () => {
    expect(render(':shipit:')).toContain(':shipit:')
    expect(render(':shipit:')).not.toContain('class="emoji"')
    expect(render('12:30:15')).toContain('12:30:15')
    expect(render('12:30:15')).not.toContain('class="emoji"')
  })

  it('does not expand a shortcode glued to a word or colon', () => {
    expect(render('foo:wave:baz')).not.toContain('class="emoji"')
    expect(render('::wave:')).not.toContain('class="emoji"')
  })
})
