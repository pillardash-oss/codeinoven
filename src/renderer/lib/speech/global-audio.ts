/**
 * Single-playback coordinator for Sound history audio vs TTS.
 * History recordings and TTS playback are mutually exclusive — last played wins.
 * This module tracks the currently playing history <audio> element so TTS can
 * pause it and history can pause TTS. It also enforces one-at-a-time among
 * history players via play listeners.
 */

let currentHistoryAudio: HTMLAudioElement | null = null

export function getCurrentHistoryAudio(): HTMLAudioElement | null {
  return currentHistoryAudio
}

export function setCurrentHistoryAudio(audio: HTMLAudioElement | null): void {
  currentHistoryAudio = audio
}

export function pauseCurrentHistoryAudio(): void {
  if (currentHistoryAudio && !currentHistoryAudio.paused) {
    currentHistoryAudio.pause()
  }
}

/**
 * Register a history <audio> element for exclusive playback among history
 * players. When any registered element starts playing, the previous one is
 * paused. Returns an unregister function for onDestroy.
 */
export function registerHistoryAudio(audio: HTMLAudioElement): () => void {
  const onPlay = (): void => {
    if (currentHistoryAudio && currentHistoryAudio !== audio) {
      currentHistoryAudio.pause()
    }
    currentHistoryAudio = audio
  }

  const onEnded = (): void => {
    if (currentHistoryAudio === audio) currentHistoryAudio = null
  }

  const onEmptied = (): void => {
    if (currentHistoryAudio === audio && audio.src === '') currentHistoryAudio = null
  }

  audio.addEventListener('play', onPlay)
  audio.addEventListener('ended', onEnded)
  audio.addEventListener('emptied', onEmptied)

  return () => {
    audio.removeEventListener('play', onPlay)
    audio.removeEventListener('ended', onEnded)
    audio.removeEventListener('emptied', onEmptied)
    if (currentHistoryAudio === audio) currentHistoryAudio = null
  }
}
