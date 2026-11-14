/**
 * Split a walkthrough into plain text and the addresses inside it.
 *
 * A walkthrough is where the user is told to "open this link", and the text is
 * rendered verbatim because it is meant to be copied. That left the address in
 * it dead: the reader had to select it and paste it somewhere by hand.
 *
 * The split happens on the string rather than on the markup, so the panel keeps
 * rendering the walkthrough exactly as written (whitespace, indentation and all)
 * while the address parts become real anchors. Only absolute web addresses are
 * matched: a scheme (`https://`, `http://`) or a `www.` host. Everything else,
 * including file paths and bare host names in prose, stays plain text so a step
 * such as `cd ./packages/app` is never turned into a link.
 */

export interface WalkthroughSegment {
  /** The text as written, shown to the reader. */
  readonly text: string
  /** The absolute address this segment opens, or `null` for plain text. */
  readonly href: string | null
}

/** An absolute web address, up to the next whitespace or markup character. */
const ADDRESS_SOURCE = /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu

/** Sentence punctuation that follows an address rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?'"\u2019\u201d]+$/u

function count(value: string, character: string): number {
  let total = 0
  for (const current of value) if (current === character) total += 1
  return total
}

/**
 * Drop what a sentence appended to the address: its final punctuation, and a
 * closing parenthesis the address itself never opened. A URL that genuinely
 * ends in a bracket, such as a Wikipedia path, keeps it because the counts
 * balance there.
 */
function trimAddress(address: string): string {
  let trimmed = address.replace(TRAILING_PUNCTUATION, '')
  while (trimmed.endsWith(')') && count(trimmed, '(') < count(trimmed, ')')) {
    trimmed = trimmed.slice(0, -1)
  }
  return trimmed
}

/** The walkthrough as text and link segments, in the order it was written. */
export function splitWalkthroughLinks(text: string): WalkthroughSegment[] {
  if (!text) return []

  const segments: WalkthroughSegment[] = []
  let cursor = 0

  for (const match of text.matchAll(ADDRESS_SOURCE)) {
    const address = trimAddress(match[0])
    if (!address || address === 'www.') continue
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), href: null })
    }
    segments.push({
      text: address,
      href: address.startsWith('www.') ? `https://${address}` : address
    })
    cursor = match.index + address.length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), href: null })
  return segments
}
