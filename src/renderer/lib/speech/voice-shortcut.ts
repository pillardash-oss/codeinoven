import { invoke } from '$lib/ipc.svelte'
import { isMacPlatform } from '$lib/keymap/keymap'
import { donListening } from '$lib/don-listening.svelte'
import { ModifierTapSequenceDetector } from '$lib/focus/modifier-tap-sequence'
import {
  DEFAULT_VOICE_RECORDING_SHORTCUT,
  MODIFIER_KEY_CODES,
  normalizeVoiceRecordingShortcut,
  type VoiceRecordingShortcut
} from '../../../lib/speech/types'
import { armPreferredVoiceHost, triggerPreferredVoiceHost } from './voice-trigger-registry'

/** How quickly the double-tap variant must be repeated to fire. */
const DOUBLE_TAP_WINDOW_MS = 500

/** Taps of the dictation modifier that raise the Don Listening panel instead of
 *  starting another recording: the pair that starts/stops dictation, plus one
 *  more press inside the same window. */
const DON_LISTENING_TAP_COUNT = 3

let currentBinding: VoiceRecordingShortcut = DEFAULT_VOICE_RECORDING_SHORTCUT

/**
 * The three-tap gesture, read from the same presses as the double tap.
 *
 * It runs beside `lastTapAt`/`tapSequenceDirty` rather than replacing them: two
 * presses keep their existing meaning (start, then stop, dictation), and the
 * third press inside the window is the longer gesture, so it opens Don Listening
 * and clears the pair it just completed. That order is what keeps a third press
 * from firing dictation a second time.
 */
let tapSequence = createTapSequence()

function createTapSequence(): ModifierTapSequenceDetector {
  return new ModifierTapSequenceDetector({
    count: DON_LISTENING_TAP_COUNT
  })
}

/**
 * Non-zero while the settings capture control is listening for a new binding —
 * the detector stands down so the keys being captured never start a recording.
 */
let captureDepth = 0

export function beginVoiceShortcutCapture(): void {
  captureDepth += 1
  // Keys pressed while the settings control is capturing never reach the
  // detector, so a half-formed sequence must not survive the capture.
  resetTapFormation()
}

export function endVoiceShortcutCapture(): void {
  captureDepth = Math.max(0, captureDepth - 1)
}

export function getVoiceRecordingShortcut(): VoiceRecordingShortcut {
  return currentBinding
}

function applyBinding(value: unknown): void {
  currentBinding = normalizeVoiceRecordingShortcut(value) ?? DEFAULT_VOICE_RECORDING_SHORTCUT
  // The binding owns which key the sequence watches, so a remap starts from a
  // clean slate instead of carrying taps of the key the user moved away from.
  tapSequence = createTapSequence()
  cancelPendingDictation()
  lastTapAt = 0
  tapSequenceDirty = false
}

async function loadInitialBinding(): Promise<void> {
  try {
    const config = await invoke('config:get')
    applyBinding(config.sound.voiceRecordingShortcut)
  } catch {
    // keep the default binding when config cannot be read yet; a later
    // cio:soundChanged event will correct it.
  }
}

function handleSoundChanged(event: Event): void {
  const detail = (event as CustomEvent<{ voiceRecordingShortcut?: unknown }>).detail
  applyBinding(detail?.voiceRecordingShortcut)
}

let lastTapAt = 0
/** Set when any other key is pressed between two taps of a bare modifier. */
let tapSequenceDirty = false
/** The dictation a completed pair is waiting to start, or null while the window
 *  is still open for the triple press that would make it Don instead. */
let pendingDictation: ReturnType<typeof setTimeout> | null = null

/** Which KeyboardEvent flag each modifier code sets for its own keydown. A
 *  modifier key's keydown always reports its own flag as true, so that flag
 *  must be exempted when matching (a bare left-Alt press has altKey=true). */
const OWN_MODIFIER_FLAG: ReadonlyMap<string, 'ctrl' | 'meta' | 'alt' | 'shift'> = new Map([
  ['AltLeft', 'alt'],
  ['AltRight', 'alt'],
  ['ControlLeft', 'ctrl'],
  ['ControlRight', 'ctrl'],
  ['MetaLeft', 'meta'],
  ['MetaRight', 'meta'],
  ['ShiftLeft', 'shift'],
  ['ShiftRight', 'shift']
])

function matchesBinding(event: KeyboardEvent, binding: VoiceRecordingShortcut): boolean {
  if (event.code !== binding.code) return false
  const ownFlag = OWN_MODIFIER_FLAG.get(binding.code) ?? null
  return (
    (ownFlag === 'ctrl' || event.ctrlKey === binding.ctrl) &&
    (ownFlag === 'meta' || event.metaKey === binding.meta) &&
    (ownFlag === 'alt' || event.altKey === binding.alt) &&
    (ownFlag === 'shift' || event.shiftKey === binding.shift)
  )
}

/** Cancel a forming tap sequence. A pointer press and a lost window are the two
 *  things a keydown can never report, and both end a gesture. */
function resetTapFormation(): void {
  tapSequence.reset()
  cancelPendingDictation()
  lastTapAt = 0
  tapSequenceDirty = true
}

const handleKeydown = (event: KeyboardEvent): void => {
  // Auto-repeat never fires the shortcut nor invalidates a forming double-tap:
  // the original non-repeat keydown already decided the tap state.
  if (captureDepth > 0 || event.repeat) return
  const binding = currentBinding
  const matches = matchesBinding(event, binding)
  if (!matches) {
    if (binding.doubleTap) {
      // Any other key cancels a forming double-tap pair (e.g. Alt+Tab), and the
      // same stray press cancels the three-tap sequence with it.
      tapSequenceDirty = true
      tapSequence.reset()
      cancelPendingDictation()
    }
    return
  }

  if (binding.doubleTap && MODIFIER_KEY_CODES.has(binding.code)) {
    // Keep a lone modifier press from moving focus (menu bar on Windows/Linux).
    event.preventDefault()
    // The detector answers the third press of the same gesture. It is fed every
    // press the pair logic sees, so the two count exactly the same taps.
    const opensDonListening = tapSequence.handleKeydown(event, binding)
    const now = performance.now()
    if (opensDonListening) {
      // The third press means Don, not dictation. Nothing has been armed by the
      // first two presses, so the pair that would have started another take is
      // dropped and the panel starts its own microphone instead.
      cancelPendingDictation()
      lastTapAt = 0
      tapSequenceDirty = false
      donListening.open({ listen: true })
      return
    }
    if (!tapSequenceDirty && now - lastTapAt <= DOUBLE_TAP_WINDOW_MS) {
      // The pair is complete, but whether it is dictation or the first two taps
      // of the triple press is not known until the window closes. Recording is
      // only asked for then, so the first press and the second never arm
      // anything, and a third press inside the window cancels it.
      lastTapAt = 0
      tapSequenceDirty = false
      scheduleDictation()
      return
    }
    lastTapAt = now
    tapSequenceDirty = false
    return
  }

  if (binding.doubleTap) return
  // A single-chord binding has no longer gesture to wait for, so the press is
  // the whole gesture: open the device early, then run the take.
  armPreferredVoiceHost()
  event.preventDefault()
  event.stopPropagation()
  triggerPreferredVoiceHost()
}

/**
 * Ask for dictation once the tap window closes with no third press.
 *
 * The dictation gesture and the Don Listening gesture share their first two
 * presses, so the pair cannot act on the second tap: doing so armed and started
 * a recording before the user had finished asking Don to listen. The take is
 * therefore deferred by exactly one window, which is the same wait the pair
 * already had to satisfy.
 */
function scheduleDictation(): void {
  cancelPendingDictation()
  pendingDictation = setTimeout(() => {
    pendingDictation = null
    lastTapAt = 0
    tapSequenceDirty = false
    triggerPreferredVoiceHost()
  }, DOUBLE_TAP_WINDOW_MS)
}

/** Drop a dictation that a third press, a stray key, or a pointer press cancelled. */
function cancelPendingDictation(): void {
  if (pendingDictation === null) return
  clearTimeout(pendingDictation)
  pendingDictation = null
}

export function initVoiceShortcutListener(): () => void {
  void loadInitialBinding()
  const handleKeyup = (event: KeyboardEvent): void => tapSequence.handleKeyup(event)
  // The held-modifier latch is fed by keyup, and a pointer press or a lost window
  // ends a forming sequence the way a stray keydown does.
  const handleReset = (): void => resetTapFormation()
  window.addEventListener('cio:soundChanged', handleSoundChanged)
  window.addEventListener('keydown', handleKeydown, true)
  window.addEventListener('keyup', handleKeyup, true)
  window.addEventListener('pointerdown', handleReset, true)
  window.addEventListener('blur', handleReset)
  return () => {
    window.removeEventListener('cio:soundChanged', handleSoundChanged)
    window.removeEventListener('keydown', handleKeydown, true)
    window.removeEventListener('keyup', handleKeyup, true)
    window.removeEventListener('pointerdown', handleReset, true)
    window.removeEventListener('blur', handleReset)
  }
}

// ─── Display helpers ────────────────────────────────────────────────────────

const CODE_LABELS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  Period: '.',
  Quote: "'",
  Semicolon: ';',
  Slash: '/',
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Del',
  Insert: 'Ins',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn'
}

function keyLabelFromCode(code: string): string {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)
  if (digit) return digit[1]
  if (/^F\d{1,2}$/.test(code)) return code
  return CODE_LABELS[code] ?? code.replace(/^([A-Za-z]+)/, '$1 ')
}

function modifierLabel(code: string): string {
  switch (code) {
    case 'AltLeft':
      return isMacPlatform() ? '⌥ Option' : 'Left Alt'
    case 'AltRight':
      return isMacPlatform() ? '⌥ Option' : 'Right Alt'
    case 'ControlLeft':
      return isMacPlatform() ? '⌃ Control' : 'Left Ctrl'
    case 'ControlRight':
      return isMacPlatform() ? '⌃ Control' : 'Right Ctrl'
    case 'MetaLeft':
      return isMacPlatform() ? '⌘ Command' : 'Left Win'
    case 'MetaRight':
      return isMacPlatform() ? '⌘ Command' : 'Right Win'
    default:
      return 'Shift'
  }
}

/** Human-readable label for a binding, e.g. "Double-press Left Alt" or "Ctrl + R". */
export function describeVoiceRecordingShortcut(
  binding: VoiceRecordingShortcut = currentBinding
): string {
  if (binding.doubleTap) return `Double-press ${modifierLabel(binding.code)}`
  const mac = isMacPlatform()
  const modifiers: string[] = []
  if (binding.meta) modifiers.push(mac ? '⌘' : 'Super')
  if (binding.ctrl) modifiers.push(mac ? '⌃' : 'Ctrl')
  if (binding.alt) modifiers.push(mac ? '⌥' : 'Alt')
  if (binding.shift) modifiers.push(mac ? '⇧' : 'Shift')
  modifiers.push(keyLabelFromCode(binding.code))
  return modifiers.join(mac ? '' : ' + ')
}
