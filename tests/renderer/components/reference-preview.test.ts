import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const repoRoot = new URL('../../../', import.meta.url)

function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(relativePath, repoRoot), 'utf8')
}

const conversationSource = readRepoFile(
  'src/renderer/lib/components/threads/ThreadView/ThreadViewConversation.svelte'
)
const threadViewSource = readRepoFile('src/renderer/lib/components/threads/ThreadView.svelte')
const readerSource = readRepoFile('src/renderer/lib/components/chats/ReferencePreview.svelte')

/**
 * A passage a message carries is truncated to a chip in the transcript, so the
 * chip has to be a control that opens the reader. It was a span with a tooltip,
 * which meant the only way to read a sent excerpt back was to hover it.
 */
describe('a sent passage opens in a reader', () => {
  it('draws the reference chip as a button that opens the passage reader', () => {
    const chipStart = conversationSource.indexOf('{#if msg.references?.length}')
    expect(chipStart).toBeGreaterThan(-1)
    const chip = conversationSource.slice(chipStart, chipStart + 2400)
    expect(chip).toMatch(/<button/)
    expect(chip).toMatch(/openReferencePreview\(\s*references,\s*reference\s*\)/)
    expect(chip).toMatch(/aria-label=\{`Read \$\{reference\.label\}`\}/)
  })

  it('mounts the reader from the view that owns the message previews', () => {
    expect(threadViewSource).toMatch(/chats\/ReferencePreview\.svelte/)
    expect(threadViewSource).toMatch(
      /reference=\{referencePreview\.items\[referencePreview\.index\]\}/
    )
    expect(threadViewSource).toMatch(
      /pager=\{board\.studioTemporaryChatContext\.referencePreviewPager\}/
    )
    expect(threadViewSource).toMatch(/closeReferencePreview/)
  })

  it("walks a message's passages the way the attachment viewer walks its files", () => {
    const contextSource = readRepoFile(
      'src/renderer/lib/components/threads/ThreadView/ThreadView-studio-temporary-chat-context.svelte.ts'
    )
    expect(contextSource).toMatch(/stepReferencePreview\(delta: number\)/)
    expect(contextSource).toMatch(/referencePreviewPager = \$derived\.by<PreviewPagerState/)
    expect(contextSource).toMatch(/reader\.items\.length < 2/)
    // The reader opens on the chip that was pressed, not on the first passage.
    expect(contextSource).toMatch(/findIndex\(\(item\) => item\.id === reference\.id\)/)
    expect(readerSource).toMatch(/<PreviewPager \{pager\} noun="passage" \/>/)
  })

  it('shows the passage above and the comment below in the attachment lightbox', () => {
    expect(readerSource).toMatch(/placement="fullscreen"/)
    expect(readerSource).toMatch(/chrome=\{false\}/)
    const passageAt = readerSource.indexOf('Selected passage')
    const commentAt = readerSource.indexOf('Your comment')
    expect(passageAt).toBeGreaterThan(-1)
    expect(commentAt).toBeGreaterThan(passageAt)
    expect(readerSource).toMatch(/DeferredMarkdownView text=\{reference\.text\}/)
    expect(readerSource).toMatch(/\{reference\.comment\}/)
  })
})
