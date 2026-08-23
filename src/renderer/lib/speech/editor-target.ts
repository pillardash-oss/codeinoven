export interface SpeechEditorSelection {
  anchor: number
  focus: number
}

export interface SpeechEditorSnapshot {
  targetId: string
  value: string
  selection: SpeechEditorSelection
  capturedAt: number
}

export type SpeechEditorApplyResult =
  | {
      ok: true
      value: string
      startOffset: number
      endOffset: number
    }
  | { ok: false; reason: 'destroyed' | 'changed' | 'invalid-selection' }

export interface SpeechEditorTarget {
  id: string
  capture: () => SpeechEditorSnapshot | null
  apply: (snapshot: SpeechEditorSnapshot, transcript: string) => SpeechEditorApplyResult
}

interface PlainTextTargetOptions {
  id: string
  element: () => HTMLInputElement | HTMLTextAreaElement | null
}

/** A selection-safe adapter for the native text controls used by compact popovers. */
export function plainTextEditorTarget(options: PlainTextTargetOptions): SpeechEditorTarget {
  return {
    id: options.id,
    capture: () => {
      const element = options.element()
      if (!element) return null
      const anchor = element.selectionStart
      const focus = element.selectionEnd
      if (anchor === null || focus === null) return null
      return {
        targetId: options.id,
        value: element.value,
        selection: { anchor, focus },
        capturedAt: Date.now()
      }
    },
    apply: (snapshot, transcript) => {
      const element = options.element()
      if (!element) return { ok: false, reason: 'destroyed' }
      if (snapshot.targetId !== options.id || element.value !== snapshot.value) {
        return { ok: false, reason: 'changed' }
      }
      const start = Math.min(snapshot.selection.anchor, snapshot.selection.focus)
      const end = Math.max(snapshot.selection.anchor, snapshot.selection.focus)
      if (start < 0 || end > element.value.length) {
        return { ok: false, reason: 'invalid-selection' }
      }
      element.setRangeText(transcript, start, end, 'end')
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: transcript })
      )
      element.focus()
      return {
        ok: true,
        value: element.value,
        startOffset: start,
        endOffset: start + transcript.length
      }
    }
  }
}
