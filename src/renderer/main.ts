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
 * The main process is the single gate for every audible alert: it owns the
 * burst dedup window and decides which surface raised the notification, so the
 * renderer plays every request it receives immediately. Cards still show for
 * every notification via the separate `notification:show` channel. Off-app
 * requests play the full-volume pair for the OS card; in-app requests play the
 * quieter, purpose-made pair for the toast and honour the user's mute
 * preference.
 */
const unsubscribeFromNotificationSound = installNotificationSound()
window.addEventListener('beforeunload', unsubscribeFromNotificationSound, { once: true })

const app = mount(App, {
  target: document.getElementById('app')!
})

export default app
