import { systemPreferences } from 'electron'
import type { SpeechMicrophoneAccess } from '../../lib/speech/types'
import { Logger } from '../system/logger'

/**
 * macOS states that will never show a prompt again, so the only honest answer
 * left is where the user has to go to change their mind.
 */
const BLOCKED_MESSAGE =
  'Microphone access is blocked. Allow it in System Settings > Privacy & Security > Microphone.'
const DECLINED_MESSAGE = 'Microphone access was not granted.'

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
    if (status === 'granted') return { granted: true }
    if (status === 'denied' || status === 'restricted') {
      return { granted: false, message: BLOCKED_MESSAGE }
    }
    // `not-determined` (and the API's `unknown`) is the only state that shows
    // the system prompt, and it stays tied to this user gesture.
    const granted = await systemPreferences.askForMediaAccess('microphone')
    return granted ? { granted: true } : { granted: false, message: DECLINED_MESSAGE }
  } catch (error) {
    Logger.error('Microphone access request failed:', error)
    return { granted: false, message: 'Microphone access could not be requested.' }
  }
}
