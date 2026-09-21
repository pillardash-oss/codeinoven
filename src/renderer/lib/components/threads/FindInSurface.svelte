<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import FindInBar from '../files/FindInBar.svelte'

  const MATCH_HIGHLIGHT = 'conversation-find-match'
  const ACTIVE_HIGHLIGHT = 'conversation-find-active'

  interface SurfaceMatch {
    range: Range
    element: HTMLElement
  }

  interface Props {
    /** The search scope: everything this find covers. It must contain every
     *  surface a match may sit in, because the container is both what gets
     *  searched and what gets watched for changes   the conversation therefore
     *  passes the whole thread view, not just its scrolling transcript, so the
     *  composer draft is included. */
    container: HTMLElement | null
    focusTrigger: number
    onClose: () => void
    /** When set, only the container's descendants matching it are read, which
     *  is how a surface picks the user content inside it (message bubbles, the
     *  composer draft) and leaves its own chrome out. */
    searchSelector?: string
    placeholder?: string
    label?: string
  }

  let {
    container,
    focusTrigger,
    onClose,
    searchSelector,
    placeholder = 'Find…',
    label = 'Find'
  }: Props = $props()

  let query = $state('')
  let activeIndex = $state(0)
  let matches = $state.raw<SurfaceMatch[]>([])

  /** A scan walks every searchable root and republishes the match state, so a
   *  mutation burst is coalesced rather than answered change by change: a
   *  streaming turn, or typing into the draft the composer now contributes to
   *  this surface, would otherwise force a full scan per character. */
  const SCAN_COALESCE_MS = 120
  let scanTimer: ReturnType<typeof setTimeout> | null = null

  function clearHighlights(): void {
    CSS.highlights?.delete(MATCH_HIGHLIGHT)
    CSS.highlights?.delete(ACTIVE_HIGHLIGHT)
  }

  function renderHighlights(): void {
    clearHighlights()
    if (!CSS.highlights || matches.length === 0) return
    CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...matches.map((match) => match.range)))
    const active = matches[activeIndex]
    if (active) CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(active.range))
  }

  function searchableRoots(): HTMLElement[] {
    if (!container) return []
    if (!searchSelector) return [container]
    return [...container.querySelectorAll<HTMLElement>(searchSelector)]
  }

  function visibleTextNode(node: Node): boolean {
    const parent = node.parentElement
    if (!parent) return false
    if (
      parent.closest('[data-find-exclude], script, style, noscript, [hidden], [aria-hidden="true"]')
    ) {
      return false
    }
    return parent.getClientRects().length > 0
  }

  function collectMatches(value: string): SurfaceMatch[] {
    if (!container || !value) return []
    const needle = value.toLocaleLowerCase()
    const result: SurfaceMatch[] = []

    for (const root of searchableRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) =>
          visibleTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      })
      let node = walker.nextNode()
      while (node) {
        const text = node.textContent ?? ''
        const searchable = text.toLocaleLowerCase()
        let offset = 0
        while (offset < searchable.length) {
          const index = searchable.indexOf(needle, offset)
          if (index === -1) break
          const range = document.createRange()
          range.setStart(node, index)
          range.setEnd(node, index + value.length)
          result.push({ range, element: node.parentElement ?? root })
          offset = index + Math.max(value.length, 1)
        }
        node = walker.nextNode()
      }
    }
    return result
  }

  function refreshMatches(): void {
    matches = collectMatches(query)
    activeIndex = Math.min(activeIndex, Math.max(matches.length - 1, 0))
    renderHighlights()
  }

  function cancelScheduledScan(): void {
    if (scanTimer === null) return
    clearTimeout(scanTimer)
    scanTimer = null
  }

  function scheduleScan(): void {
    if (scanTimer !== null) return
    scanTimer = setTimeout(() => {
      scanTimer = null
      refreshMatches()
    }, SCAN_COALESCE_MS)
  }

  async function handleQueryChange(value: string): Promise<void> {
    query = value
    activeIndex = 0
    cancelScheduledScan()
    await tick()
    refreshMatches()
    scrollToCurrent()
  }

  function scrollToCurrent(): void {
    const match = matches[activeIndex]
    if (!match) return
    match.element.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function goToNext(): void {
    if (matches.length === 0) return
    activeIndex = (activeIndex + 1) % matches.length
    renderHighlights()
    scrollToCurrent()
  }

  function goToPrev(): void {
    if (matches.length === 0) return
    activeIndex = (activeIndex - 1 + matches.length) % matches.length
    renderHighlights()
    scrollToCurrent()
  }

  function handleClose(): void {
    query = ''
    activeIndex = 0
    matches = []
    cancelScheduledScan()
    clearHighlights()
    onClose()
  }

  $effect(() => {
    const surface = container
    if (!surface || !query) return
    const observer = new MutationObserver((records) => {
      const onlyFindBarChanged = records.every((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement
        return target !== null && target.closest('[data-find-exclude]') !== null
      })
      if (onlyFindBarChanged) return
      scheduleScan()
    })
    observer.observe(surface, { childList: true, characterData: true, subtree: true })
    return () => {
      observer.disconnect()
      cancelScheduledScan()
    }
  })

  onDestroy(() => {
    cancelScheduledScan()
    clearHighlights()
  })
</script>

<FindInBar
  {query}
  matches={matches.length}
  {activeIndex}
  {placeholder}
  {label}
  floating
  {focusTrigger}
  onQueryChange={(value) => void handleQueryChange(value)}
  onNext={goToNext}
  onPrev={goToPrev}
  onClose={handleClose}
/>
