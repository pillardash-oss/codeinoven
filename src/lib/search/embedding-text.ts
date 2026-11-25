/**
 * What an embedding document leaves out before it becomes a vector.
 *
 * A window is a character slice of the conversation, and nothing in the pipeline
 * treated a fence differently from prose: ` ```mermaid ` source, `graph TD` edges
 * and `<svg>` artifact markup were embedded as ordinary tokens. Measured on this
 * corpus they are also the densest content a window carries: with them in, a
 * 4 K-character window needed the whole 2047-token budget (7.6 s of one core) and
 * routinely lost its tail to the cap; without them the same window needed 4.5 s
 * and fit, at no measurable cost to retrieval (recall@1 0.800 against 0.820 on 50
 * queries, one query's worth, which is the resolution floor).
 *
 * Keyword search is untouched by this: the full-text index keeps the raw
 * `search_text`, so code is still findable by the words in it. Only the vector
 * drops it, because a vector made mostly of syntax retrieves syntax.
 */

/**
 * Fenced blocks, ``` and ~~~ both, with or without a language tag.
 *
 * Non-greedy across lines, so two fences in one window are two blocks rather than
 * one region that swallows the conversation between them.
 */
const FENCED_BLOCK = /(^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?(?:```|~~~)[ \t]*(?=\n|$)/gu

/** Inline SVG, which is how an artifact or a diagram reaches a text part. */
const SVG_BLOCK = /<svg\b[\s\S]*?<\/svg>/giu

/**
 * Remove fenced code blocks and inline SVG from one document.
 *
 * Inline code between single backticks is kept: a bare identifier is a concept the
 * user searches for, and it is three tokens rather than three hundred. A block is
 * replaced by a newline rather than by nothing, so the prose on either side of it
 * never fuses into one word.
 */
export function stripCodeAndDiagrams(text: string): string {
  if (!text.includes('```') && !text.includes('~~~') && !text.toLowerCase().includes('<svg'))
    return text
  return (
    text
      .replace(FENCED_BLOCK, '\n')
      .replace(SVG_BLOCK, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      // A block at the start or end of a window must not leave blank lines in a
      // document that begins or ends with the conversation.
      .replace(/^\n+/u, '')
      .replace(/\n+$/u, '')
  )
}
