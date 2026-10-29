import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import { installRendererErrorCapture } from './lib/system/renderer-logger'
import { installNotificationSound } from './lib/notification-sound'
import { scheduleDeferredWork } from './lib/deferred-work'
import { preloadSpotlightChunk } from './lib/page-preload'
import { preloadRestoredThreadConversation } from './lib/stores/thread-preload'
import { warmOverlayHostOnFirstGesture } from './lib/overlay-host-warm'

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

// The thread this launch restores is the first thing the user looks at, and its
// transcript is one IPC read the main process can answer immediately. Start it
// here, before the app mounts: the read then overlaps the whole hydration pass
// (project and thread lists, sidebar, chrome) instead of beginning only once the
// workspace has resolved the saved row and opened it, which is what left the
// conversation blank for the first moments of a launch.
preloadRestoredThreadConversation()

const app = mount(App, {
  target: document.getElementById('app')!
})

// Drop the static first-frame skeleton (index.html) only once the app has
// painted over it. `mount` builds the DOM synchronously but the compositor draws
// it a frame later, so removing the skeleton in the same task would expose the
// empty surface it exists to cover. Two frames: the first commits the app's DOM,
// the second means it has been drawn.
requestAnimationFrame(() => {
  requestAnimationFrame(() => document.getElementById('boot-skeleton')?.remove())
})

// The spotlight is the app's most-used surface and it is a dynamic import at its
// render site, reached by a keyboard shortcut. Nothing can warm it on hover, so
// the first Cmd/Ctrl+K of a session would pay the chunk fetch and module eval on
// the keypress itself. Warming it once the renderer is idle removes that wait.
scheduleDeferredWork('spotlight:palette', preloadSpotlightChunk)

// Every canonical modal is projected into the shared native overlay host, which
// is created on demand. Loading it at boot held a second renderer for sessions
// that never draw in it, and leaving it to the modal's own gesture means the
// app window paints nothing while its document loads. The first gesture is the
// honest middle: nothing is held for a session nobody has touched, and the host
// is already loading before the click that opens the first dialog.
const stopOverlayHostWarm = warmOverlayHostOnFirstGesture()
window.addEventListener('beforeunload', stopOverlayHostWarm, { once: true })

export default app
