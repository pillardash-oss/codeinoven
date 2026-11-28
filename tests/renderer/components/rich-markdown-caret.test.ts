// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { placeCaretAtEnd, renderRichMarkdown } from '$lib/components/shared/rich-markdown'

/**
 * A draft that ends in a code block comes back with the caret at its end. The
 * code block is a `contenteditable="false"` wrapper with its own inner editing
 * host, so a caret collapsed after the wrapper sat at the editing frame's outer
 * edge: the browser drops that selection before the next keydown, and ArrowDown
 * no longer leaves the block. The caret must end inside the block's code text.
 */

const editors: HTMLElement[] = []

function render(markdown: string): HTMLElement {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.innerHTML = renderRichMarkdown(markdown)
  document.body.append(editor)
  editors.push(editor)
  return editor
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.remove()
  window.getSelection()?.removeAllRanges()
})

describe('placeCaretAtEnd', () => {
  it('ends inside a trailing code block instead of after its wrapper', () => {
    const editor = render('Hello\n\n```ts\nconst a = 1\nconst b = 2\n```')
    const code = editor.querySelector('code') as HTMLElement

    placeCaretAtEnd(editor)

    const selection = window.getSelection()
    expect(selection?.anchorNode).not.toBe(editor)
    expect(selection?.isCollapsed).toBe(true)
    expect(code.contains(selection?.anchorNode ?? null)).toBe(true)
    expect(selection?.anchorNode).toBe(code)
    expect(selection?.anchorOffset).toBe(code.childNodes.length)
  })

  it('ends inside a trailing code block whose wrapper follows an empty paragraph', () => {
    const editor = render('Hello\n\n```ts\nprint(1)\n```\n\n')
    const code = editor.querySelector('code') as HTMLElement

    placeCaretAtEnd(editor)

    expect(code.contains(window.getSelection()?.anchorNode ?? null)).toBe(true)
  })

  it('keeps a plain trailing paragraph editable at the end', () => {
    const editor = render('Hello\n\n```ts\nprint(1)\n```\n\nAfter')
    const paragraph = editor.lastElementChild as HTMLElement
    const code = editor.querySelector('code') as HTMLElement

    placeCaretAtEnd(editor)

    const anchor = window.getSelection()?.anchorNode ?? null
    expect(code.contains(anchor)).toBe(false)
    expect(anchor === editor || paragraph.contains(anchor)).toBe(true)
  })
})
