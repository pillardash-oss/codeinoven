/**
 * Searchable identifiers a skill body names while its frontmatter does not.
 *
 * Library search indexes a skill's name, its frontmatter description, and its
 * tags only, so a skill that wraps a vendor stays invisible to a query naming
 * that vendor even when the body states it plainly. The word "brave" lives in
 * the `web-search` skill's body as `api.search.brave.com` and
 * `BRAVE_SEARCH_API_KEY`, and nowhere else.
 *
 * Host labels and compound ALL_CAPS credential names are the honest signal
 * here: they carry the vendor without dragging prose into the index, and they
 * are already the identifiers this app treats as the strongest capability
 * hints. Only underscore-separated constants qualify, so the emphatic prose of
 * a skill body (IMPORTANT, NEVER, BAD) never becomes a search keyword. The scan
 * window is bounded so a large SKILL.md costs a fixed amount of work no matter
 * how long it grows.
 */

/** Characters of body text a search index may inspect. */
const BODY_SCAN_LIMIT = 8_000

/** Longest keyword list one skill may contribute. */
const MAX_KEYWORDS = 24

/** Shortest keyword worth indexing. */
const MIN_KEYWORD_LENGTH = 3

/** Host labels and credential words that name no vendor. */
const GENERIC_KEYWORDS = new Set([
  'all',
  'and',
  'api',
  'apis',
  'app',
  'apps',
  'are',
  'args',
  'auth',
  'authorization',
  'base',
  'bearer',
  'body',
  'both',
  'cdn',
  'code',
  'com',
  'config',
  'content',
  'data',
  'default',
  'delete',
  'dev',
  'doc',
  'docs',
  'each',
  'endpoint',
  'env',
  'false',
  'file',
  'files',
  'flag',
  'flags',
  'for',
  'from',
  'get',
  'global',
  'head',
  'host',
  'http',
  'https',
  'id',
  'ids',
  'input',
  'json',
  'key',
  'keys',
  'kind',
  'list',
  'local',
  'localhost',
  'markdown',
  'mcp',
  'mode',
  'name',
  'net',
  'not',
  'null',
  'only',
  'optional',
  'org',
  'output',
  'page',
  'pages',
  'param',
  'params',
  'path',
  'paths',
  'post',
  'put',
  'read',
  'required',
  'run',
  'secret',
  'secrets',
  'server',
  'set',
  'site',
  'sites',
  'static',
  'text',
  'the',
  'this',
  'token',
  'tokens',
  'true',
  'type',
  'uri',
  'url',
  'urls',
  'use',
  'used',
  'using',
  'value',
  'values',
  'view',
  'www',
  'yaml'
])

/**
 * Extract the vendor and provider identifiers named in a skill body.
 *
 * Two shapes are read from a bounded window: host labels from URLs
 * (`api.search.brave.com` yields `search brave`) and underscore-separated
 * ALL_CAPS identifiers (`BRAVE_SEARCH_API_KEY` yields `brave search`). Generic
 * structural and credential words are dropped, and the result is a
 * space-separated string ready to be appended to searchable text.
 */
export function skillSearchKeywords(markdown: string): string {
  const window = markdown.slice(0, BODY_SCAN_LIMIT)
  const keywords: string[] = []
  const seen = new Set<string>()
  const add = (candidate: string): void => {
    const keyword = candidate.toLocaleLowerCase()
    if (keyword.length < MIN_KEYWORD_LENGTH || /^\d+$/u.test(keyword)) return
    if (GENERIC_KEYWORDS.has(keyword) || seen.has(keyword)) return
    seen.add(keyword)
    keywords.push(keyword)
  }

  for (const match of window.matchAll(/https?:\/\/([^\s"'`)\]}>]+)/gu)) {
    const host = match[1].split(/[/?#]/u)[0]
    for (const label of host.split(/[^a-z0-9]+/giu)) add(label)
  }

  for (const match of window.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/gu)) {
    for (const part of match[0].split('_')) add(part)
  }

  return keywords.slice(0, MAX_KEYWORDS).join(' ')
}
