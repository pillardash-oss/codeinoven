/**
 * The app's audible notification alerts, one pair per surface.
 *
 * The two surfaces are split by who can actually see the card, so one
 * notification is never announced twice and nothing is ever announced for a
 * card the user cannot see:
 *
 * - `system` (off-app) uses the long `alert*.wav` pair. While the app is in the
 *   background the OS notification card is the visible surface, so the main
 *   process decides and dispatches this alert over IPC at full volume.
 * - `in-app` uses the shorter, purpose-made `alert-in-app*.wav` pair. While the
 *   app is in front the sonner toast is the visible surface, so the renderer
 *   plays this alert itself, from the single place that shows that toast. A
 *   suppressed toast (the user is already on the notified thread) is therefore
 *   silent too. It is an attention cue for something already on screen, so it
 *   plays at a reduced volume and must never startle or distract.
 *
 * Each surface keeps its own burst window, sharing
 * `NOTIFICATION_SOUND_DEDUP_MS`: the main process gates the off-app alert, this
 * module gates the in-app one. The one user preference (the in-app groups can be
 * muted in Settings > Notifications) is read from the reactive config store
 * here, so a toggle takes effect on the very next alert.
 */
import { subscribe } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import {
  inAppSoundGroup,
  NOTIFICATION_SOUND_DEDUP_MS,
  type NotificationSoundKind
} from '$shared/ipc-contract'

type AlertSurface = 'system' | 'in-app'

/**
 * Playback volume of the in-app alerts: clearly audible, well under the
 * off-app alert. They announce something the user can already see on screen,
 * so they are a cue, not a summons.
 */
const IN_APP_ALERT_VOLUME = 0.5

const ALERT_KINDS: readonly NotificationSoundKind[] = ['default', 'attention']
const ALERT_SURFACES: readonly AlertSurface[] = ['system', 'in-app']

const ALERT_SOURCES: Record<AlertSurface, Record<NotificationSoundKind, string>> = {
  system: {
    default: 'alert.wav',
    attention: 'alert-attention.wav'
  },
  'in-app': {
    default: 'alert-in-app.wav',
    attention: 'alert-in-app-attention.wav'
  }
}

/**
 * One reusable element per kind and surface, so the two volumes never fight
 * over a shared element while an alert is still playing.
 */
const alerts = new Map<string, HTMLAudioElement>()

/** When the in-app alert last played, for its own burst window. */
let lastInAppAlertAt = 0

function alertElement(kind: NotificationSoundKind, surface: AlertSurface): HTMLAudioElement {
  const key = `${surface}:${kind}`
  const existing = alerts.get(key)
  if (existing) return existing
  const audio = new Audio(new URL(ALERT_SOURCES[surface][kind], document.baseURI).href)
  audio.preload = 'auto'
  audio.volume = surface === 'in-app' ? IN_APP_ALERT_VOLUME : 1
  // Kick the fetches off immediately so the first alert starts instantly
  // instead of waiting on a lazy load while the app is busy.
  void audio.load()
  alerts.set(key, audio)
  return audio
}

function playAlert(kind: NotificationSoundKind, surface: AlertSurface): void {
  const audio = alertElement(kind, surface)
  audio.currentTime = 0
  void audio.play().catch(() => undefined)
}

/**
 * Announce the in-app toast this window is about to show. Called from the one
 * place that shows that toast, so the alert exists exactly when the card does:
 * nothing plays for a suppressed toast, and no alert announces a notification
 * the user is already looking at.
 *
 * Stays silent while another window holds focus (that window shows the toast,
 * and the background case is announced by the off-app alert), when the user
 * muted this alert's group, and for the rest of a burst.
 */
export function playInAppAlert(kind: NotificationSoundKind): void {
  if (!document.hasFocus()) return
  if (!appConfigState.inAppNotificationSound[inAppSoundGroup(kind)]) return
  const now = Date.now()
  if (now - lastInAppAlertAt < NOTIFICATION_SOUND_DEDUP_MS) return
  lastInAppAlertAt = now
  playAlert(kind, 'in-app')
}

/**
 * Preload every alert and wire the off-app alert channel. Returns the
 * unsubscribe function for teardown.
 */
export function installNotificationSound(): () => void {
  for (const surface of ALERT_SURFACES) {
    for (const kind of ALERT_KINDS) {
      alertElement(kind, surface)
    }
  }
  return subscribe('notification:playSound', (kind) => playAlert(kind, 'system'))
}
