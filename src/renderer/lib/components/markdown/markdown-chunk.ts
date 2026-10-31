/**
 * The markdown renderer's chunks, and the order they are allowed to arrive in.
 *
 * The transcript's text is the last thing on the first screen that has to cross
 * a module boundary, and the module behind it is the heaviest one the renderer
 * has: the parser, the sanitizer, and every block renderer a message can
 * contain. Only the first two are needed to read a message, so the rarer block
 * renderers (a Mermaid diagram, an artifact fence, a table with its column
 * controls) live in their own chunks and are fetched when a message actually
 * contains one.
 *
 * Every loader here is memoized, so the pending `{#await}` in a component and
 * the warm-up below share one fetch instead of racing two, and a chunk that
 * failed to load is forgotten rather than cached as a permanent failure.
 */
import { ensureGithubEmojiData } from './github-emoji-data.svelte'

type MarkdownViewModule = typeof import('./MarkdownView.svelte')
type MermaidDiagramModule = typeof import('./MermaidDiagram.svelte')
type ArtifactCardModule = typeof import('./ArtifactCard.svelte')
type MarkdownTableModule = typeof import('./MarkdownTable.svelte')

/** One memoized loader. A failure is forgotten, so the next attempt retries. */
function memoize<Module>(load: () => Promise<Module>): () => Promise<Module> {
  let pending: Promise<Module> | null = null
  return () => {
    pending ??= load().catch((error: unknown) => {
      pending = null
      throw error
    })
    return pending
  }
}

/** The parser and the eager block renderers: the one chunk reading text needs. */
export const loadMarkdownView = memoize<MarkdownViewModule>(() => import('./MarkdownView.svelte'))

/** A Mermaid diagram, only for a message that contains a complete fence. */
export const loadMermaidDiagram = memoize<MermaidDiagramModule>(
  () => import('./MermaidDiagram.svelte')
)

/** An artifact fence, only for a message that contains one. */
export const loadArtifactCard = memoize<ArtifactCardModule>(() => import('./ArtifactCard.svelte'))

/** A table with its wrap, column-resize and full-screen controls. */
export const loadMarkdownTable = memoize<MarkdownTableModule>(
  () => import('./MarkdownTable.svelte')
)

/**
 * Fetch the text renderer once the conversation has painted.
 *
 * The transcript's own text starts this fetch the moment its first block
 * mounts, so the warm exists for the surfaces that only render markdown later
 * (a pull-request body, a spec studio, a changelog) and would otherwise pay a
 * cold chunk on that click. It runs after the first screen, never before it, so
 * it cannot compete with the conversation's own reads.
 *
 * The shortcode table is warmed beside it: it is data the renderer only needs
 * when a `:shortcode:` appears, and warming it here is what keeps that
 * appearance from resolving a frame late.
 */
export function warmMarkdown(): void {
  void loadMarkdownView().catch(() => undefined)
  void ensureGithubEmojiData()
}
