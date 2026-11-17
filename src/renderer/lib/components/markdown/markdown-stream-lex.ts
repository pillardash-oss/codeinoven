/**
 * Lex cache for one streaming markdown surface.
 *
 * A streamed message only ever grows at its tail, yet every re-render used to
 * hand the whole document to `marked`: it re-tokenizes every block and every
 * inline span inside every block, per frame, so one turn costs O(text) per frame
 * and O(text²) over its life.
 *
 * This keeps the tokens of the previous lex. When the next text extends them,
 * every block but the last is reused by identity and only the tail is tokenized.
 * A block that is still being written is always the last one, so the boundary
 * after the second-to-last block is exactly the point where re-tokenizing can
 * safely stop: everything before it was a finished block then and stays one now.
 *
 * Reused tokens are the same objects, so `blockHtml` keeps hitting its per-block
 * cache and the mounted block components keep their identity.
 */
import type { Token } from 'marked'
import {
  blockLexMarkdown,
  prepareMarkdown,
  resolveFootnotes,
  type CitationThreadContext
} from './markdown'
import { citationPathsState } from '$lib/stores/citation-paths.svelte'
import { githubEmojiRevision } from './github-emoji-data.svelte'
import { hasGithubEmojiCandidate } from './github-emoji'
import type { GithubRepoContext } from '$lib/github-references'

/**
 * A link reference definition (`[label]: url`) is the one markdown construct
 * that lives outside the block stream: `marked` keeps it in the lexer's `links`
 * table and never emits it as a token, so its source is missing from the token
 * array and a separately lexed tail cannot see a definition anywhere else in the
 * document. Text that holds one therefore takes the whole-document path.
 *
 * The same pattern covers footnote definitions, which is also what keeps token
 * `raw` a faithful concatenation of the source: nothing is dropped from the
 * stream, so the reused prefix can be compared against the source byte for byte.
 */
const LINK_DEFINITION_PATTERN = /^ {0,3}\[[^\]\n]+\]:/mu

interface CachedLex {
  prepared: string
  tokens: Token[]
  /** Everything the cached tokens depend on besides the source text itself. */
  signature: string
}

export class StreamingMarkdownLex {
  /**
   * One entry per rendered segment (a source with an over-long line renders as
   * several). One entry is the normal case; the map only ever grows with those
   * segments and is dropped whole when that number changes.
   */
  #cached = new Map<number, CachedLex>()

  /**
   * Tokens for `text`, ready to render.
   *
   * Returns the very same array when the text did not change, so a re-render of
   * an unchanged message costs a string identity check.
   */
  lex(
    segment: number,
    text: string,
    allowHtml: boolean,
    repository: GithubRepoContext | null,
    citationThread?: CitationThreadContext
  ): Token[] {
    // Both revisions are read in the caller's reactive context, so a bump
    // re-evaluates this call, and both belong in the signature so the bumped
    // evaluation cannot be served tokens built before it: a file citation
    // becomes a link only once its path is confirmed, and a shortcode only once
    // its table has landed. Only text that holds a shortcode candidate depends
    // on (and subscribes to) the table, so the rest never re-lexes when it lands.
    const revision = citationPathsState.revision
    const emoji = hasGithubEmojiCandidate(text) ? `e${githubEmojiRevision()}` : ''
    const signature = [
      allowHtml ? 'html' : 'plain',
      repository ? `${repository.owner}/${repository.repo}` : '',
      `r${revision}`,
      emoji,
      citationThread
        ? `${citationThread.projectId}/${citationThread.threadId}/${citationThread.scopeBucketId ?? ''}`
        : ''
    ].join('\u0000')

    const prepared = prepareMarkdown(text, citationThread)
    const cached = this.#cached.get(segment)
    if (cached && cached.signature === signature) {
      if (cached.prepared === prepared) return cached.tokens
      const reused = this.#reuseTail(cached, prepared, allowHtml, repository)
      if (reused) {
        cached.prepared = prepared
        cached.tokens = reused
        return reused
      }
    }

    const tokens = resolveFootnotes(blockLexMarkdown(prepared, allowHtml, repository))
    if (this.#cached.size > 8 && !this.#cached.has(segment)) this.#cached.clear()
    this.#cached.set(segment, { prepared, tokens, signature })
    return tokens
  }

  /**
   * Re-lex only what follows the second-to-last block, or `null` when the
   * previous tokens cannot be reused safely.
   */
  #reuseTail(
    cached: CachedLex,
    prepared: string,
    allowHtml: boolean,
    repository: GithubRepoContext | null
  ): Token[] | null {
    if (!prepared.startsWith(cached.prepared)) return null
    if (LINK_DEFINITION_PATTERN.test(prepared)) return null
    const last = cached.tokens[cached.tokens.length - 1]
    if (!last) return null
    const boundary = cached.prepared.length - last.raw.length
    if (boundary <= 0) return null
    const reuse = cached.tokens.slice(0, -1)
    // The cached tokens must still account for exactly the source they were
    // lexed from. They always do (the definition gate above keeps `raw` a
    // faithful copy of the source), and proving it here costs one comparison
    // pass while removing any chance of rendering a block twice or not at all.
    if (!reuseTokensCover(reuse, prepared, boundary)) return null
    // Footnotes need no re-resolution here: a document cannot hold a definition
    // (gated above), so the tail can only produce references that stay literal.
    return [...reuse, ...blockLexMarkdown(prepared.slice(boundary), allowHtml, repository)]
  }
}

/** Whether `tokens` are exactly the source `prepared.slice(0, boundary)`. */
function reuseTokensCover(tokens: readonly Token[], prepared: string, boundary: number): boolean {
  let offset = 0
  for (const token of tokens) {
    if (prepared.startsWith(token.raw, offset) === false) return false
    offset += token.raw.length
    if (offset > boundary) return false
  }
  return offset === boundary
}
