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
 * exactly like the user pressing send, instead of a second, drifting copy of
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
  /**
   * The durable value behind this field, and the only way it is written.
   *
   * A recording outlives the box it was started in: the popover can be closed,
   * the view switched, or the surface re-rendered while the model is still
   * transcribing. Supplying the mirror makes the target self-sufficient
   * instead of losing the transcript the moment the element is gone: whatever
   * the field stores is where the recording lands, whether or not the element
   * is still on screen to receive it.
   */
  mirror?: {
    read: () => string
    write: (value: string) => void
  }
}

function appendToMirror(
  id: string,
  mirror: NonNullable<PlainTextTargetOptions['mirror']>,
  snapshot: SpeechEditorSnapshot,
  transcript: string
): SpeechEditorApplyResult {
  const base = mirror.read()
  // The recording started from exactly this value, so the caret it was left at
  // still describes where the transcript belongs. A field that changed
  // underneath the model keeps its new text and takes the transcript after it,
  // which is the only insertion that cannot destroy what the user typed.
  const baseMatchesSnapshot = snapshot.targetId === id && snapshot.value === base
  let start: number
  let next: string
  if (baseMatchesSnapshot) {
    const selectionStart = Math.min(snapshot.selection.anchor, snapshot.selection.focus)
    const selectionEnd = Math.max(snapshot.selection.anchor, snapshot.selection.focus)
    start = selectionStart
    next = base.slice(0, selectionStart) + transcript + base.slice(selectionEnd)
  } else if (base.length === 0) {
    start = 0
    next = transcript
  } else {
    const separator = /\s$/.test(base) ? '' : ' '
    start = base.length + separator.length
    next = base + separator + transcript
  }
  mirror.write(next)
  return { ok: true, value: next, startOffset: start, endOffset: start + transcript.length }
}

/** A selection-safe adapter for the native text controls used by compact popovers. */
export function plainTextEditorTarget(options: PlainTextTargetOptions): SpeechEditorTarget {
  const mirror = options.mirror
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
    },
    ...(mirror
      ? {
          fallbackApply: (snapshot: SpeechEditorSnapshot, transcript: string) =>
            appendToMirror(options.id, mirror, snapshot, transcript)
        }
      : {})
  }
}
