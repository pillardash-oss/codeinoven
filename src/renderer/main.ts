import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { createRingBufferLogger, setRemoteLogger } from './lib/remote/logger'
import { installRendererErrorCapture } from './lib/system/renderer-logger'

// Retain remote-connection diagnostics in memory so they are observable (the
// Remote view exposes them) without using console.*.
setRemoteLogger(createRingBufferLogger())

// Capture renderer JS errors (uncaught exceptions, unhandled rejections, and
// console.error output) from the first renderer statement and forward them to
// the main-process durable log so client crashes are diagnosable on disk.
installRendererErrorCapture()

const notificationSound = new Audio(new URL('./alert.wav', document.baseURI).href)
notificationSound.preload = 'auto'
// Kick the fetch off at startup so the first alert starts instantly instead of
// waiting on a lazy load when the app is backgrounded.
void notificationSound.load()

/**
 * The main process is the single gate for the audible alert: it only emits
 * `notification:playSound` for the first notification of a burst, so the
 * renderer plays every event it receives — immediately. Cards still show for
 * every notification via the separate `notification:show` channel.
 */
function playNotificationSound(): void {
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
