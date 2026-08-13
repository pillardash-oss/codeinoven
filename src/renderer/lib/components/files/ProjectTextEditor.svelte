<script lang="ts">
  import { highlightFileContent } from './file-language'

  interface Props {
    value: string
    path: string
    readonly?: boolean
    showLineNumbers?: boolean
    wrap?: boolean
    ariaLabel: string
    spellcheck?: boolean
    findQuery?: string
    findActiveIndex?: number
    focusLine?: number | null
    focusLineRequest?: number
    onInput: (event: Event) => void
    onKeydown: (event: KeyboardEvent) => void
    onFindMatches?: (matches: number) => void
  }

  let {
    value,
    path,
    readonly = false,
    showLineNumbers = true,
    wrap = false,
    ariaLabel,
    spellcheck = false,
    findQuery = '',
    findActiveIndex = 0,
    focusLine = null,
    focusLineRequest = 0,
    onInput,
    onKeydown,
    onFindMatches = undefined
  }: Props = $props()

  let editor = $state<HTMLTextAreaElement | null>(null)
  let gutter = $state<HTMLPreElement | null>(null)
  let highlightLayer = $state<HTMLPreElement | null>(null)
  let findHighlightLayer = $state<HTMLPreElement | null>(null)
  let handledFocusLineRequest = 0
  let highlighted = $derived(highlightFileContent(value, path))
  let lineMetrics = $derived.by(() => {
    let count = 1
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) === 10) count += 1
    }
    let numbers = ''
    for (let line = 1; line <= count; line += 1) {
      numbers += line === count ? String(line) : `${line}\n`
    }
    return {
      numbers,
      gutterWidth: `${Math.max(3, String(count).length) + 2}ch`
    }
  })

  let findMatchPositions = $derived.by(() => {
    if (!findQuery) return [] as Array<[number, number]>
    const lowerText = value.toLowerCase()
    const lowerQuery = findQuery.toLowerCase()
    const positions: Array<[number, number]> = []
    let pos = 0
    while (true) {
      const idx = lowerText.indexOf(lowerQuery, pos)
      if (idx === -1) break
      positions.push([idx, idx + lowerQuery.length])
      pos = idx + 1
    }
    return positions
  })

  function escapeHtml(text: string): string {
    return text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
  }

  let findHighlighted = $derived.by(() => {
    if (findMatchPositions.length === 0) return ''
    let result = ''
    let cursor = 0
    for (const [index, match] of findMatchPositions.entries()) {
      const [start, end] = match
      result += escapeHtml(value.slice(cursor, start))
      const background =
        index === findActiveIndex
          ? 'color-mix(in srgb, var(--color-primary) 52%, transparent)'
          : 'color-mix(in srgb, var(--color-accent) 30%, transparent)'
      result += `<mark style="background:${background};color:transparent;border-radius:2px">${escapeHtml(value.slice(start, end))}</mark>`
      cursor = end
    }
    return result + escapeHtml(value.slice(cursor))
  })

  $effect(() => {
    onFindMatches?.(findMatchPositions.length)
  })

  $effect(() => {
    const match = findMatchPositions[findActiveIndex]
    if (!editor || !match) return
    editor.setSelectionRange(match[0], match[1])
    const lineHeight = 20
    const textBefore = value.slice(0, match[0])
    const linesBefore = textBefore.split('\n').length - 1
    editor.scrollTop = Math.max(0, linesBefore * lineHeight - editor.clientHeight / 3)
  })

  $effect(() => {
    const requestedLine = focusLine
    const request = focusLineRequest
    if (!editor || !requestedLine || request === 0 || request === handledFocusLineRequest) return
    handledFocusLineRequest = request

    // A citation line is only a scroll target. Do not focus the editor or move
    // its selection: the user's caret remains wherever they put it.
    const line = Math.max(1, Math.floor(requestedLine))
    editor.scrollTop = Math.max(0, (line - 1) * 20 - editor.clientHeight / 3)
    handleScroll()
  })

  function handleScroll(): void {
    if (!editor) return
    if (gutter) gutter.scrollTop = editor.scrollTop
    if (highlightLayer) {
      highlightLayer.scrollTop = editor.scrollTop
      highlightLayer.scrollLeft = editor.scrollLeft
    }
    if (findHighlightLayer) {
      findHighlightLayer.scrollTop = editor.scrollTop
      findHighlightLayer.scrollLeft = editor.scrollLeft
    }
  }
</script>

<div class="flex min-h-0 flex-1 overflow-hidden bg-app">
  {#if showLineNumbers}
    <pre
      bind:this={gutter}
      class="min-h-0 shrink-0 select-none overflow-hidden border-r border-border bg-surface px-2 py-3 text-right font-mono text-xs leading-5 text-dimmed"
      style:width={lineMetrics.gutterWidth}
      aria-hidden="true">{lineMetrics.numbers}</pre>
  {/if}
  <div class="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-app">
    <!-- eslint-disable svelte/no-at-html-tags -- highlight.js escapes source and emits only span tokens -->
    <pre
      bind:this={highlightLayer}
      class={[
        'hljs pointer-events-none absolute inset-0 overflow-hidden bg-transparent p-3 font-mono text-xs leading-5',
        wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
      ]}
      style:tab-size="2"
      aria-hidden="true"><code>{@html highlighted}</code></pre>
    <!-- eslint-enable svelte/no-at-html-tags -->
    {#if findHighlighted}
      <!-- eslint-disable svelte/no-at-html-tags -- source is escaped before match marks are added -->
      <pre
        bind:this={findHighlightLayer}
        class={[
          'pointer-events-none absolute inset-0 overflow-hidden bg-transparent p-3 font-mono text-xs leading-5 text-transparent',
          wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'
        ]}
        style:tab-size="2"
        aria-hidden="true">{@html findHighlighted}</pre>
      <!-- eslint-enable svelte/no-at-html-tags -->
    {/if}
    <textarea
      bind:this={editor}
      class="absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent p-3 font-mono text-xs leading-5 text-transparent caret-foreground outline-none selection:bg-primary/30 placeholder:text-dimmed"
      style:tab-size="2"
      {value}
      {readonly}
      aria-label={ariaLabel}
      autocomplete="off"
      autocapitalize="off"
      {spellcheck}
      wrap={wrap ? 'soft' : 'off'}
      oninput={onInput}
      onkeydown={onKeydown}
      onscroll={handleScroll}></textarea>
  </div>
</div>
