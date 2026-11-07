/**
 * Link a scheme-less web host in plain text.
 *
 * GitHub-flavoured autolinks cover a URL only when it carries a scheme
 * (`https://host/path`), a `www.` prefix, or is an email address. A host written
 * the way people write it in prose, `app.posthog.com/settings/user-api-keys`,
 * stays plain text under that rule   which is what a credential card showed: a
 * URL the reader could see but not click.
 *
 * This pass runs over the plain text tokens of a paragraph, so it never sees
 * code spans, link labels, or URLs that the built-in tokenizer already linked.
 * It is deliberately conservative: the last label of the host has to be a real
 * web TLD, the host has to start at a word boundary, and a trailing sentence
 * mark belongs to the sentence rather than to the URL. A file name such as
 * `package.json` or `renderer.ts` therefore keeps its plain text.
 */

/** Web TLDs common enough that a bare `host.tld` in prose reads as a web address. */
const WEB_TLDS = [
  'com',
  'org',
  'net',
  'edu',
  'gov',
  'io',
  'ai',
  'dev',
  'app',
  'co',
  'me',
  'so',
  'tv',
  'cc',
  'xyz',
  'info',
  'biz',
  'page',
  'site',
  'tech',
  'cloud',
  'run',
  'tools',
  'us',
  'uk',
  'de',
  'fr',
  'es',
  'it',
  'nl',
  'se',
  'no',
  'ca',
  'au',
  'nz',
  'in',
  'jp',
  'eu'
]

const HOST_LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?'

/** A host followed by an optional port and path, starting at a word boundary. */
const BARE_WEB_URL_SOURCE = `(^|[\\s([{"'\\u2018\\u201c<])((?:${HOST_LABEL}\\.)+(?:${WEB_TLDS.join('|')}))(?::\\d{1,5})?(?:[/?#][^\\s<>"'\`]*)?`

const TRAILING_PUNCTUATION = /[.,;:!?'"\u2019\u201d]+$/u

function count(value: string, character: string): number {
  let total = 0
  for (const current of value) if (current === character) total += 1
  return total
}

/**
 * Drop what a sentence appended to the URL: its final punctuation, and a
 * closing parenthesis the URL itself never opened.
 */
function trimBareUrl(url: string): string {
  let trimmed = url.replace(TRAILING_PUNCTUATION, '')
  while (trimmed.endsWith(')') && count(trimmed, '(') < count(trimmed, ')')) {
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

/**
 * The text with every bare web host wrapped in an anchor, or `null` when the
 * text holds none so the caller can keep using marked's own renderer.
 *
 * `escape` is the caller's HTML escaper: this module emits markup, and the
 * caller owns the escaping rules for the document it is building.
 */
export function linkifyBareWebUrls(text: string, escape: (value: string) => string): string | null {
  if (!text.includes('.')) return null
  const pattern = new RegExp(BARE_WEB_URL_SOURCE, 'giu')
  let html = ''
  let cursor = 0
  let found = false

  for (const match of text.matchAll(pattern)) {
    const whole = match[0]
    const lead = match[1] ?? ''
    const url = trimBareUrl(whole.slice(lead.length))
    if (!url) continue
    const start = match.index
    html += escape(text.slice(cursor, start + lead.length))
    html += `<a href="${escape(`https://${url}`)}">${escape(url)}</a>`
    cursor = start + lead.length + url.length
    found = true
  }

  if (!found) return null
  return html + escape(text.slice(cursor))
}
