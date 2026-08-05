<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import FindInBar from '../files/FindInBar.svelte'
  import type { AgentMessage } from '$shared/types'

  const MATCH_HIGHLIGHT = 'conversation-find-match'
  const ACTIVE_HIGHLIGHT = 'conversation-find-active'

  interface ConversationMatch {
    range: Range
    element: HTMLElement
  }

  interface Props {
    messages: AgentMessage[]
    container: HTMLElement | null
    focusTrigger: number
    onClose: () => void
  }

  let { messages, container, focusTrigger, onClose }: Props = $props()

  let query = $state('')
  let activeIndex = $state(0)
  let matches = $state.raw<ConversationMatch[]>([])

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

  function collectMatches(value: string): ConversationMatch[] {
    if (!container || !value) return []
    const needle = value.toLocaleLowerCase()
    const result: ConversationMatch[] = []

    for (const element of container.querySelectorAll<HTMLElement>(
      '[data-conversation-searchable]'
    )) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
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
          result.push({ range, element })
          offset = index + Math.max(value.length, 1)
        }
        node = walker.nextNode()
      }
    }
    return result
  }

  async function handleQueryChange(value: string): Promise<void> {
    query = value
    activeIndex = 0
    await tick()
    matches = collectMatches(value)
    renderHighlights()
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
    clearHighlights()
    onClose()
  }

  $effect(() => {
    if (!query) return
    if (messages.length === 0) {
      matches = []
      clearHighlights()
      return
    }
    void tick().then(() => {
      matches = collectMatches(query)
      activeIndex = Math.min(activeIndex, Math.max(matches.length - 1, 0))
      renderHighlights()
    })
  })

  onDestroy(clearHighlights)
</script>

<FindInBar
  {query}
  matches={matches.length}
  {activeIndex}
  placeholder="Find in conversation…"
  label="Find in conversation"
  floating
  {focusTrigger}
  onQueryChange={(value) => void handleQueryChange(value)}
  onNext={goToNext}
  onPrev={goToPrev}
  onClose={handleClose}
/>
