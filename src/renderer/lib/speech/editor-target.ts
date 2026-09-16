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

/**
 * Optional dispatch capability for editors whose content is itself a message
 * (the chat composer). Armed voice dictation delivers its transcript through
 * the host's own send path so queueing, steering, and every send gate behave
 * exactly like the user pressing send — instead of a second, drifting copy of
 * those rules living in the speech layer.
 */
export interface SpeechEditorAutoSend {
  /** True while the editor that owns this target is mounted and usable. */
  isLive: () => boolean
  /**
   * Dispatch the editor's current content. `direct` forces an immediate send
   * into a live turn (a steer) instead of queueing behind the running turn.
   */
  submit: (direct: boolean) => void
}

export interface SpeechEditorTarget {
  id: string
  capture: () => SpeechEditorSnapshot | null
  apply: (snapshot: SpeechEditorSnapshot, transcript: string) => SpeechEditorApplyResult
  /** Present only on targets that can send themselves (see `SpeechEditorAutoSend`). */
  autoSend?: SpeechEditorAutoSend
  /**
   * Optional store-level fallback used when `apply` cannot insert because the
   * editor element was destroyed (e.g. the view was navigated away while
   * recording was still active). The implementation should write the transcript
   * into the backing value and report where it was inserted.
   */
  fallbackApply?: (snapshot: SpeechEditorSnapshot, transcript: string) => SpeechEditorApplyResult
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
