<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { Token, Tokens } from 'marked'
  import CodeBlock from './CodeBlock.svelte'
  import MermaidDiagram from './MermaidDiagram.svelte'
  import FileCitationContextMenu from './FileCitationContextMenu.svelte'
  import { blockHtml, fileCitationTarget, lexMarkdown } from './markdown'
  import { openInBrowser } from '$lib/open-in-browser'
  import { extractCitationCandidates } from '$lib/agent-source-citations'
  import { revealCitationFile, revealLocalFile } from '$lib/reveal-file'
  import { citationPathsState } from '$lib/stores/citation-paths.svelte'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

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
    onCiteFile,
    onOpenLocalFile,
    onAnnotateMermaid
  }: Props = $props()

  const tokens = $derived(lexMarkdown(text, allowHtml))
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
      {@html blockHtml(token, allowHtml)}
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
    {@render renderBlocks(tokens)}
  </div>
</FileCitationContextMenu>

{#if tooltip}
  <div
    class="pointer-events-none fixed z-50 max-w-96 -translate-x-1/2 rounded-lg border border-border bg-overlay px-2.5 py-1.5 text-[11px] leading-snug break-all text-foreground shadow-lg"
    style:left={`${tooltip.x}px`}
    style:top={`${tooltip.y}px`}
    role="tooltip"
  >
    {tooltip.text}
  </div>
{/if}
