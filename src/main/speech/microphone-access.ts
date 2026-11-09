import { systemPreferences } from 'electron'
import type { SpeechMicrophoneAccess } from '../../lib/speech/types'
import { Logger } from '../system/logger'

/** macOS states that will never show a prompt again, so the only honest answer
 * left is where the user has to go to change their mind. */
const BLOCKED_MESSAGE =
  'Microphone access is blocked. Allow it in System Settings > Privacy & Security > Microphone.'
const DECLINED_MESSAGE = 'Microphone access was not granted.'

// Shared by every recording surface and the native capture path. A successful
// request is authoritative for this process even if a later status read is
// unresolved. Explicit denial/restriction still invalidates that decision.
let grantedInSession = false
let pendingAccess: Promise<SpeechMicrophoneAccess> | null = null

/**
 * Whether microphone access is already granted, without asking for it.
 *
 * Opening the capture device is the only thing that may not happen unchecked:
 * `granted` never prompts, while `not-determined` would turn a device open into
 * the permission dialog the user has not asked for. Every device-open path
 * therefore asks this first, so a fresh install stays silent until the
 * recording gesture asks.
 */
export function microphoneAccessGranted(): boolean {
  // Only macOS gates capture behind a TCC decision, and only macOS has a native
  // capture worker at all.
  if (process.platform !== 'darwin') return false
  try {
    return systemPreferences.getMediaAccessStatus('microphone') === 'granted'
  } catch (error) {
    Logger.error('Could not read the microphone access status:', error)
    return false
  }
}

/**
 * Resolve microphone access at the moment the user asks to record.
 *
 * macOS only shows its microphone prompt for a process that touches the input
 * device, so *anything* that opens an input device at launch turns startup into
 * a permission request. That is exactly what the capture worker's CoreAudio
 * warmup did, and a fresh install asked for the microphone before the user had
 * recorded anything. This helper is therefore the only place the request is
 * issued: it runs when a recording is starting, and it reports a denial as a
 * value instead of throwing, so the renderer can settle the attempt as the
 * permission failure it is.
 */
export async function requestMicrophoneAccess(): Promise<SpeechMicrophoneAccess> {
  // Every other platform gates the microphone at `getUserMedia` time already.
  if (process.platform !== 'darwin') return { granted: true }
  try {
    const status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'granted') {
      grantedInSession = true
      return { granted: true }
    }
    if (status === 'denied' || status === 'restricted') {
      grantedInSession = false
      return { granted: false, message: BLOCKED_MESSAGE }
    }
    if (grantedInSession) return { granted: true }
    if (pendingAccess) return await pendingAccess
    // `not-determined` (and the API's `unknown`) is the only state that shows
    // the system prompt. Share it across overlapping recording gestures.
    const request = systemPreferences.askForMediaAccess('microphone').then((granted) => {
      grantedInSession = granted
      return granted ? { granted: true } : { granted: false, message: DECLINED_MESSAGE }
    })
    pendingAccess = request
    try {
      return await request
    } finally {
      pendingAccess = null
    }
  } catch (error) {
    Logger.error('Microphone access request failed:', error)
    return { granted: false, message: 'Microphone access could not be requested.' }
  }
}
