import { invoke } from '$lib/ipc.svelte'
import { isMacPlatform } from '$lib/keymap/keymap'
import {
  DEFAULT_VOICE_RECORDING_SHORTCUT,
  MODIFIER_KEY_CODES,
  normalizeVoiceRecordingShortcut,
  type VoiceRecordingShortcut
} from '../../../lib/speech/types'
import { triggerPreferredVoiceHost } from './voice-trigger-registry'

/** How quickly the double-tap variant must be repeated to fire. */
const DOUBLE_TAP_WINDOW_MS = 500

let currentBinding: VoiceRecordingShortcut = DEFAULT_VOICE_RECORDING_SHORTCUT

/**
 * Non-zero while the settings capture control is listening for a new binding —
 * the detector stands down so the keys being captured never start a recording.
 */
let captureDepth = 0

export function beginVoiceShortcutCapture(): void {
  captureDepth += 1
}

export function endVoiceShortcutCapture(): void {
  captureDepth = Math.max(0, captureDepth - 1)
}

export function getVoiceRecordingShortcut(): VoiceRecordingShortcut {
  return currentBinding
}

function applyBinding(value: unknown): void {
  currentBinding = normalizeVoiceRecordingShortcut(value) ?? DEFAULT_VOICE_RECORDING_SHORTCUT
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

const handleKeydown = (event: KeyboardEvent): void => {
  // Auto-repeat never fires the shortcut nor invalidates a forming double-tap:
  // the original non-repeat keydown already decided the tap state.
  if (captureDepth > 0 || event.repeat) return
  const binding = currentBinding
  const matches =
    event.code === binding.code &&
    event.ctrlKey === binding.ctrl &&
    event.metaKey === binding.meta &&
    event.altKey === binding.alt &&
    event.shiftKey === binding.shift
  if (!matches) {
    if (binding.doubleTap) {
      // Any other key cancels a forming double-tap pair (e.g. Alt+Tab).
      tapSequenceDirty = true
    }
    return
  }

  if (binding.doubleTap && MODIFIER_KEY_CODES.has(binding.code)) {
    // Keep a lone modifier press from moving focus (menu bar on Windows/Linux).
    event.preventDefault()
    const now = performance.now()
    if (!tapSequenceDirty && now - lastTapAt <= DOUBLE_TAP_WINDOW_MS) {
      lastTapAt = 0
      tapSequenceDirty = false
      triggerPreferredVoiceHost()
      return
    }
    lastTapAt = now
    tapSequenceDirty = false
    return
  }

  if (binding.doubleTap) return
  event.preventDefault()
  event.stopPropagation()
  triggerPreferredVoiceHost()
}

export function initVoiceShortcutListener(): () => void {
  void loadInitialBinding()
  window.addEventListener('cio:soundChanged', handleSoundChanged)
  window.addEventListener('keydown', handleKeydown, true)
  return () => {
    window.removeEventListener('cio:soundChanged', handleSoundChanged)
    window.removeEventListener('keydown', handleKeydown, true)
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
  if (binding.meta) modifiers.push(mac ? '⌘' : 'Cmd')
  if (binding.ctrl) modifiers.push(mac ? '⌃' : 'Ctrl')
  if (binding.alt) modifiers.push(mac ? '⌥' : 'Alt')
  if (binding.shift) modifiers.push(mac ? '⇧' : 'Shift')
  modifiers.push(keyLabelFromCode(binding.code))
  return modifiers.join(mac ? '' : ' + ')
}
