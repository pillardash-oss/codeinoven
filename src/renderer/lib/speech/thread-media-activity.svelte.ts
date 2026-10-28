import { browserAudio } from '$lib/stores/browser-audio.svelte'
import { speechController } from './speech-controller.svelte'
import type { MediaActivity } from '$shared/media-activity'

/** A thread's media trail, independent of its work or transcription status. */
export function threadMediaActivity(threadId: string): MediaActivity[] {
  const kinds = browserAudio.activitiesForThread(threadId)
  if (speechController.isRecordingThread(threadId) && !kinds.includes('microphone'))
    kinds.push('microphone')
  if (speechController.isSpeakingThread(threadId) && !kinds.includes('audio')) kinds.push('audio')
  return kinds
}
