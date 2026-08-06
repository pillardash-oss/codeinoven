import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { createRingBufferLogger, setRemoteLogger } from './lib/remote/logger'

// Retain remote-connection diagnostics in memory so they are observable (the
// Remote view exposes them) without using console.*.
setRemoteLogger(createRingBufferLogger())

const notificationSound = new Audio(new URL('./alert.wav', document.baseURI).href)
notificationSound.preload = 'auto'

/**
 * Multiple notifications arriving at the same time each dispatch a
 * `notification:playSound` event. The cards for those notifications still show
 * individually, but the audible alert must only play once per burst, so
 * playback is gated by a cooldown window covering the alert's duration.
 */
const NOTIFICATION_SOUND_DEDUP_MS = 2_500
let lastNotificationSoundPlayedAt = 0

function playNotificationSound(): void {
  const now = Date.now()
  if (now - lastNotificationSoundPlayedAt < NOTIFICATION_SOUND_DEDUP_MS) return
  lastNotificationSoundPlayedAt = now
  notificationSound.currentTime = 0
  void notificationSound.play().catch(() => undefined)
}

const unsubscribeFromNotificationSound = window.api.on(
  'notification:playSound',
  playNotificationSound
)
window.addEventListener('beforeunload', unsubscribeFromNotificationSound, { once: true })

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
