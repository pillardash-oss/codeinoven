/** Shared media activity vocabulary used from view rails down to browser tabs. */
export type MediaActivity = 'audio' | 'microphone' | 'camera' | 'screen'

export interface CaptureActivity {
  microphoneActive?: boolean
  cameraActive?: boolean
  screenActive?: boolean
}

export function captureActivities(
  state: CaptureActivity & { capturing?: boolean }
): MediaActivity[] {
  const result: MediaActivity[] = []
  if (state.microphoneActive) result.push('microphone')
  if (state.cameraActive) result.push('camera')
  if (state.screenActive) result.push('screen')
  // Older snapshots lack typed capture details. Keep their recording mark visible.
  if (state.capturing && result.length === 0) result.push('microphone')
  return result
}

export const MEDIA_ACTIVITY_LABEL: Record<MediaActivity, string> = {
  audio: 'Playing audio',
  microphone: 'Microphone in use',
  camera: 'Camera in use',
  screen: 'Sharing screen'
}
