import { insertPlainText } from './components/shared/rich-markdown'
import type { AppBridge } from '../../preload/index'

declare global {
  interface Window {
    api: AppBridge
  }
}

export interface EditorSpelling {
  word: string
  suggestions: string[]
  ignore: (() => void) | null
  replace: (suggestion: string) => void
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' })

function wordAt(text: string, offset: number): { word: string; start: number; end: number } | null {
  // Only inspect the clicked word's neighborhood, including for very long notes.
  const start = Math.max(0, offset - 128)
  const end = Math.min(text.length, offset + 128)
  const segment = words.segment(text.slice(start, end)).containing(offset - start)
  if (!segment?.isWordLike) return null
  const from = start + segment.index
  const to = from + segment.segment.length
  if ((from === start && start > 0) || (to === end && end < text.length)) return null
  return { word: segment.segment, start: from, end: to }
}

/** Capture a correction target before the context menu takes focus. */
export function editorSpellingAt(event: MouseEvent, element: HTMLElement): EditorSpelling | null {
  if (!element.spellcheck || !window.api?.spellcheck) return null
  const doc = element.ownerDocument
  const field = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
  let word: ReturnType<typeof wordAt>
  let range: Range | null = null
  if (field) {
    if (
      element.disabled ||
      element.readOnly ||
      (element instanceof HTMLInputElement && element.type === 'password')
    )
      return null
    const offset = element.selectionStart
    if (offset === null) return null
    word = wordAt(element.value, offset)
  } else {
    const point = doc.caretPositionFromPoint(event.clientX, event.clientY)
    if (!point || !(point.offsetNode instanceof Text) || !element.contains(point.offsetNode))
      return null
    if (
      point.offsetNode.parentElement?.closest(
        '[spellcheck="false"], [contenteditable="false"], [data-editor-spelling-ignored]'
      )
    )
      return null
    word = wordAt(point.offsetNode.data, point.offset)
    if (!word) return null
    range = doc.createRange()
    range.setStart(point.offsetNode, word.start)
    range.setEnd(point.offsetNode, word.end)
    if (
      !Array.from(range.getClientRects()).some(
        (rect) =>
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
      )
    )
      return null
  }
  if (!word) return null
  const { word: original, start, end } = word
  if (!window.api.spellcheck.isMisspelled(original)) return null
  const suggestions = window.api.spellcheck.suggestions(original)
  const savedRange = range
  const originalValue = field ? element.value : null
  return {
    word: original,
    suggestions,
    ignore: savedRange
      ? () => {
          if (
            !element.isConnected ||
            !element.contains(savedRange.commonAncestorContainer) ||
            savedRange.startContainer !== savedRange.endContainer ||
            savedRange.toString() !== original
          )
            return
          // File editors own their DOM and supply a model decoration instead.
          if (
            !element.dispatchEvent(
              new CustomEvent('editor-ignore-spelling', {
                bubbles: true,
                cancelable: true,
                detail: savedRange
              })
            )
          )
            return
          const span = doc.createElement('span')
          span.spellcheck = false
          span.dataset.editorSpellingIgnored = 'true'
          savedRange.surroundContents(span)
          element.focus({ preventScroll: true })
        }
      : null,
    replace(suggestion): void {
      if (!suggestions.includes(suggestion) || !element.isConnected) return
      if (field ? element.value !== originalValue : savedRange?.toString() !== original) return
      element.focus({ preventScroll: true })
      if (field) {
        element.setSelectionRange(start, end)
      } else if (savedRange) {
        const selection = doc.getSelection()
        if (!selection) return
        selection.removeAllRanges()
        selection.addRange(savedRange)
      }
      const options: InputEventInit = {
        bubbles: true,
        inputType: 'insertReplacementText',
        data: suggestion
      }
      if (!element.dispatchEvent(new InputEvent('beforeinput', { ...options, cancelable: true })))
        return
      if (field) element.setRangeText(suggestion, start, end, 'end')
      else insertPlainText(element, suggestion)
      element.dispatchEvent(new InputEvent('input', options))
    }
  }
}
