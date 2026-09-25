import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { installRendererErrorCapture } from './lib/system/renderer-logger'
import { installNotificationSound } from './lib/notification-sound'

// Capture renderer JS errors (uncaught exceptions, unhandled rejections, and
// console.error output) from the first renderer statement and forward them to
// the main-process durable log so client crashes are diagnosable on disk.
installRendererErrorCapture()

/**
 * Alerts are split by surface. While the app is in the background the main
 * process dispatches the off-app alert for the OS card, and this renderer plays
 * every request it receives. While the app is in front the OS card is
 * suppressed, so the in-app alert is played by the renderer at the moment it
 * shows the toast (see app-ipc-subscriptions.ts), which keeps the cue and the
 * card in lockstep. Cards still show for every notification via the separate
 * `notification:show` channel.
 */
const unsubscribeFromNotificationSound = installNotificationSound()
window.addEventListener('beforeunload', unsubscribeFromNotificationSound, { once: true })

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
