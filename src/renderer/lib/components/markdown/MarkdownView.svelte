<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Token, Tokens } from 'marked'
  import CodeBlock from './CodeBlock.svelte'
  import LongTextBlock from './LongTextBlock.svelte'
  import MermaidDiagram from './MermaidDiagram.svelte'
  import FileCitationContextMenu from './FileCitationContextMenu.svelte'
  import { blockHtml, fileCitationTarget, lexMarkdownCached } from './markdown'
  import { openInBrowser } from '$lib/open-in-browser'
  import { extractCitationCandidates } from '$lib/agent-source-citations'
  import { revealCitationFile, revealLocalFile } from '$lib/reveal-file'
  import { citationPathsState } from '$lib/stores/citation-paths.svelte'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface InlineFileTag {
    /** The exact `@path` token in the source text to replace with the chip. */
    token: string
    /**
     * Trusted, self-contained HTML for the inline tag chip. This is built by
     * the caller from validated project references (never from user-authored
     * markup) and is injected after sanitization, so it bypasses DOMPurify.
     */
    html: string
  }

  interface Props {
    /** Markdown source — may be an incomplete, still-streaming message. */
    text: string
    class?: string
    /**
     * Render raw HTML tags in the source instead of showing them as text.
     * Only for content authored on a provider whose markdown dialect includes
     * HTML (GitHub pull requests) — never for agent output or user input.
     * Sanitizing still strips scripts, frames, styles, and form controls.
     */
    allowHtml?: boolean
    /**
     * Replace exact `@path` tokens in the source with trusted inline chips.
     * Used for user messages that tag project files/directories so a long
     * project-relative path renders as a compact tag instead of raw text.
     */
    inlineFileTags?: ReadonlyArray<InlineFileTag>
    /** Fired when a file citation is clicked. */
    onCiteFile?: (path: string, line?: number) => void
    /** Fired when an explicit local file URL is clicked. */
    onOpenLocalFile?: (url: string) => void
    /** Fired when an annotatable Mermaid diagram requests a review comment. */
    onAnnotateMermaid?: (code: string, event: MouseEvent) => void
  }

  let {
    text,
    class: className = '',
    allowHtml = false,
    inlineFileTags = [],
    onCiteFile,
    onOpenLocalFile,
    onAnnotateMermaid
  }: Props = $props()

  /**
   * Substitute each reference token with a private-use placeholder before
   * lexing so the markdown pipeline treats the token as opaque text. The
   * placeholder is then swapped for the trusted chip HTML after DOMPurify has
   * sanitized the block, keeping user-authored markup escaped the whole way.
   */
  const tagSubstitutions = $derived.by(() => {
    const tags = inlineFileTags
      .filter((tag) => tag.token.length > 0)
      .slice()
      .sort((left, right) => right.token.length - left.token.length)
    if (tags.length === 0) return { prepared: text, substitutions: new Map<string, string>() }
    let prepared = text
    const substitutions = new Map<string, string>() // eslint-disable-line svelte/prefer-svelte-reactivity
    for (const [index, tag] of tags.entries()) {
      if (!prepared.includes(tag.token)) continue
      const placeholder = `\uE7F0${index}\uE7F1`
      prepared = prepared.split(tag.token).join(placeholder)
      substitutions.set(placeholder, tag.html)
    }
    return { prepared, substitutions }
  })

  /** The text actually lexed for rendering. Starts as the initial text so the
   *  first paint is synchronous and correct; streaming updates re-lex at most
   *  once per animation frame below, so a burst of chunks coalesces into a
   *  single lex. Completed messages never change text and never re-lex. */
  // Intentional initial-value capture — the first paint must lex synchronously.
  // svelte-ignore state_referenced_locally
  let lexedText = $state(tagSubstitutions.prepared)
  // svelte-ignore state_referenced_locally
  let lexedAllowHtml = $state(allowHtml)
  let lexFrame = 0
  let lexPending: { text: string; allowHtml: boolean } | null = null

  $effect(() => {
    const prepared = tagSubstitutions.prepared
    const htmlMode = allowHtml
    if (prepared === lexedText && htmlMode === lexedAllowHtml) return
    lexPending = { text: prepared, allowHtml: htmlMode }
    if (lexFrame) return
    lexFrame = requestAnimationFrame(() => {
      lexFrame = 0
      if (!lexPending) return
      lexedText = lexPending.text
      lexedAllowHtml = lexPending.allowHtml
      lexPending = null
    })
  })

  /** Any single line longer than this never enters the markdown pipeline or
   *  the DOM as one unbroken run. A 500KB single-line dump would otherwise
   *  cost marked's inline tokenizer, DOMPurify, and soft-wrap layout the full
   *  price at once; it renders collapsed via `LongTextBlock` instead. */
  const LONG_LINE_LIMIT = 2_000

  interface MarkdownSegment {
    kind: 'markdown' | 'long'
    text: string
  }

  /** Fence-aware split of the source at over-long lines. Lines inside a
   *  fenced code block stay with their fence (CodeBlock already bounds
   *  highlight cost and scrolls horizontally); everything else keeps its
   *  normal markdown rendering. With no over-long line this yields exactly
   *  one markdown segment, so normal messages are unaffected. */
  function splitLongLineSegments(source: string): MarkdownSegment[] {
    if (!source.includes('\n') && source.length <= LONG_LINE_LIMIT) {
      return [{ kind: 'markdown', text: source }]
    }
    const lines = source.split('\n')
    let anyLong = false
    for (const line of lines) {
      if (line.length > LONG_LINE_LIMIT) {
        anyLong = true
        break
      }
    }
    if (!anyLong) return [{ kind: 'markdown', text: source }]
    const segments: MarkdownSegment[] = []
    let buffer: string[] = []
    let fenceCharacter = ''
    let fenceLength = 0
    let inFence = false
    const flush = (): void => {
      if (buffer.length > 0) {
        segments.push({ kind: 'markdown', text: buffer.join('\n') })
        buffer = []
      }
    }
    for (const line of lines) {
      const fence = inFence
        ? line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
        : line.match(/^ {0,3}(`{3,}|~{3,})/)
      if (fence) {
        if (!inFence) {
          inFence = true
          fenceCharacter = fence[1][0]
          fenceLength = fence[1].length
        } else if (fence[1][0] === fenceCharacter && fence[1].length >= fenceLength) {
          inFence = false
        }
      }
      if (!inFence && line.length > LONG_LINE_LIMIT) {
        flush()
        segments.push({ kind: 'long', text: line })
      } else {
        buffer.push(line)
      }
    }
    flush()
    return segments
  }

  const segments = $derived(splitLongLineSegments(lexedText))

  function renderBlockHtml(token: Token): string {
    const html = blockHtml(token, allowHtml)
    const { substitutions } = tagSubstitutions
    if (substitutions.size === 0) return html
    let result = html
    for (const [placeholder, chip] of substitutions) {
      result = result.replaceAll(placeholder, chip)
    }
    return result
  }
  let tooltip = $state<{ text: string; x: number; y: number } | null>(null)
  let tooltipTimer: ReturnType<typeof setTimeout> | null = null
  let tooltipLink: HTMLAnchorElement | null = null

  // Register cited paths for existence checks so only files that truly exist
  // render as links. Streaming re-fires per chunk, but the store dedupes.
  $effect(() => {
    citationPathsState.ensureActiveProjectChecked(extractCitationCandidates(text))
    faviconState.ensureResolved(faviconState.externalUrlsFromText(text))
  })

  onDestroy(() => {
    if (tooltipTimer) clearTimeout(tooltipTimer)
    if (lexFrame) cancelAnimationFrame(lexFrame)
  })

  function isCodeToken(token: Token): token is Tokens.Code {
    return token.type === 'code'
  }

  function isListToken(token: Token): token is Tokens.List {
    return token.type === 'list'
  }

  function isBlockquoteToken(token: Token): token is Tokens.Blockquote {
    return token.type === 'blockquote'
  }

  function isCompleteFence(token: Tokens.Code): boolean {
    const opening = token.raw.match(/^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/)
    if (!opening) return true
    const fenceCharacter = opening[2][0]
    const fenceLength = opening[2].length
    const closingFence = new RegExp(`\\n {0,3}${fenceCharacter}{${fenceLength},}[ \\t]*(?:\\n|$)`)
    return closingFence.test(token.raw)
  }

  function linkFromEvent(event: Event): HTMLAnchorElement | null {
    const link = (event.target as Element | null)?.closest('a')
    return link instanceof HTMLAnchorElement ? link : null
  }

  function citationFromLink(link: HTMLAnchorElement): { path: string; line?: number } | null {
    const path = link.dataset.citationPath
    const line = link.dataset.citationLine
    if (path) return { path, ...(line ? { line: Number(line) } : {}) }
    const href = link.getAttribute('href')
    return href ? fileCitationTarget(href) : null
  }

  function destinationForLink(link: HTMLAnchorElement): string | null {
    const citation = citationFromLink(link)
    if (citation) return `${citation.path}${citation.line ? `:${citation.line}` : ''}`
    const href = link.getAttribute('href')
    // Fragment links (footnotes, section anchors) stay inside the document —
    // no external destination to preview, so no tooltip.
    if (!href || href.startsWith('#')) return null
    return href
  }

  function clearTooltip(): void {
    if (tooltipTimer) clearTimeout(tooltipTimer)
    tooltipTimer = null
    tooltipLink = null
    tooltip = null
  }

  function scheduleTooltip(link: HTMLAnchorElement): void {
    const destination = destinationForLink(link)
    if (!destination || tooltipLink === link) return
    clearTooltip()
    tooltipLink = link
    tooltipTimer = setTimeout(() => {
      const bounds = link.getBoundingClientRect()
      tooltip = {
        text: destination,
        x: Math.min(window.innerWidth - 16, Math.max(16, bounds.left + bounds.width / 2)),
        y: Math.min(window.innerHeight - 16, bounds.bottom + 8)
      }
      tooltipTimer = null
    }, 1_000)
  }

  function handlePointerOver(event: PointerEvent): void {
    const link = linkFromEvent(event)
    if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return
    scheduleTooltip(link)
  }

  function handlePointerOut(event: PointerEvent): void {
    const link = linkFromEvent(event)
    if (!link || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return
    clearTooltip()
  }

  function handleFocusIn(event: FocusEvent): void {
    const link = linkFromEvent(event)
    if (link) scheduleTooltip(link)
  }

  function handleFocusOut(event: FocusEvent): void {
    if (linkFromEvent(event)) clearTooltip()
  }

  function openCitation(path: string, line?: number): void {
    if (onCiteFile) {
      if (line !== undefined && onCiteFile.length < 2) {
        onCiteFile(`${path}:${line}`)
      } else {
        onCiteFile(path, line)
      }
      return
    }
    const projectId = workspaceState.activeProject?.id
    if (projectId) void revealCitationFile(projectId, path, line)
  }

  function handleClick(event: MouseEvent): void {
    const link = linkFromEvent(event)
    if (!link) return
    const citation = citationFromLink(link)
    if (citation) {
      event.preventDefault()
      clearTooltip()
      openCitation(citation.path, citation.line)
      return
    }

    const href = link.getAttribute('href')
    if (!href) return
    if (href.startsWith('file://')) {
      event.preventDefault()
      clearTooltip()
      if (onOpenLocalFile) {
        onOpenLocalFile(href)
      } else {
        void revealLocalFile(workspaceState.activeProject?.id, href)
      }
      return
    }
    if (href.startsWith('http://') || href.startsWith('https://')) {
      event.preventDefault()
      clearTooltip()
      void openInBrowser(href)
    }
  }

  /** Mirror of the citation click path — used by the file context menu's
   *  "Open file" action so both interactions behave identically. */
  function openCitationFromMenu(path: string, line?: number): void {
    openCitation(path, line)
  }
</script>

<!--
  Marked's streaming token arrays only grow or mutate at the tail. Index keys
  therefore keep completed blocks and the active CodeBlock instance stable.
-->
{#snippet renderBlocks(blockTokens: Token[])}
  {#each blockTokens as token, index (index)}
    {#if isCodeToken(token)}
      {@const language = token.lang?.split(/\s+/)[0]?.toLowerCase()}
      {#if language === 'mermaid' && isCompleteFence(token)}
        <MermaidDiagram code={token.text} onAnnotate={onAnnotateMermaid} />
      {:else}
        <CodeBlock code={token.text} lang={language} />
      {/if}
    {:else if isListToken(token)}
      {#if token.ordered}
        <ol start={token.start === '' ? undefined : token.start}>
          {#each token.items as item, itemIndex (itemIndex)}
            <li class={{ 'task-list-item': item.task }}>
              {@render renderBlocks(item.tokens)}
            </li>
          {/each}
        </ol>
      {:else}
        <ul>
          {#each token.items as item, itemIndex (itemIndex)}
            <li class={{ 'task-list-item': item.task }}>
              {@render renderBlocks(item.tokens)}
            </li>
          {/each}
        </ul>
      {/if}
    {:else if isBlockquoteToken(token)}
      <blockquote>
        {@render renderBlocks(token.tokens)}
      </blockquote>
    {:else if token.type !== 'space'}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
      {@html renderBlockHtml(token)}
    {/if}
  {/each}
{/snippet}

<FileCitationContextMenu onOpenFile={openCitationFromMenu}>
  <div
    class={['markdown-body min-w-0 max-w-full', className]}
    role="presentation"
    onclick={handleClick}
    onpointerover={handlePointerOver}
    onpointerout={handlePointerOut}
    onfocusin={handleFocusIn}
    onfocusout={handleFocusOut}
  >
    {#each segments as seg, segIndex (segIndex)}
      {#if seg.kind === 'long'}
        <LongTextBlock text={seg.text} />
      {:else}
        {@render renderBlocks(lexMarkdownCached(seg.text, lexedAllowHtml))}
      {/if}
    {/each}
  </div>
</FileCitationContextMenu>

{#if tooltip}
  <div
    class="pointer-events-none fixed z-50 max-w-96 -translate-x-1/2 rounded-lg border border-border bg-overlay px-2.5 py-1.5 text-[0.6875rem] leading-snug break-all text-foreground shadow-lg"
    style:left={`${tooltip.x}px`}
    style:top={`${tooltip.y}px`}
    role="tooltip"
  >
    {tooltip.text}
  </div>
{/if}
