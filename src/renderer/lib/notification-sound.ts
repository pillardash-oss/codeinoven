/**
 * The app's audible notification alerts, for both surfaces.
 *
 * Each surface has its own pair of bundled alerts. `system` uses the long
 * `alert*.wav` pair that announces an OS notification card while the app is in
 * the background. `in-app` uses the shorter, purpose-made `alert-in-app*.wav`
 * pair that announces the sonner toast for the exact same event while the user
 * is looking at the app: it is an attention cue, so it is played at a reduced
 * volume and must never startle or distract.
 *
 * The main process owns every decision about *whether* an alert happens (the
 * burst dedup window and which surface is in front, so one notification is
 * never announced twice). This module owns *how* it sounds, plus the single
 * user preference: the in-app groups can be muted in Settings > Notifications,
 * and reading that preference from the reactive config store here makes a
 * toggle take effect on the very next alert.
 */
import { subscribe } from '$lib/ipc.svelte'
import { appConfigState } from '$lib/stores/app-config.svelte'
import { inAppSoundGroup } from '$shared/ipc-contract'
import type { NotificationSoundRequest } from '$shared/ipc-contract'

type AlertKind = NotificationSoundRequest['kind']
type AlertSurface = NotificationSoundRequest['surface']

/**
 * Playback volume of the in-app alerts: clearly audible, well under the
 * off-app alert. They announce something the user can already see on screen,
 * so they are a cue, not a summons.
 */
const IN_APP_ALERT_VOLUME = 0.5

const ALERT_KINDS: readonly AlertKind[] = ['default', 'attention']
const ALERT_SURFACES: readonly AlertSurface[] = ['system', 'in-app']

const ALERT_SOURCES: Record<AlertSurface, Record<AlertKind, string>> = {
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

function alertElement(kind: AlertKind, surface: AlertSurface): HTMLAudioElement {
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

/** Play one alert request, unless the user muted that in-app group. */
function playNotificationSound(request: NotificationSoundRequest): void {
  if (
    request.surface === 'in-app' &&
    !appConfigState.inAppNotificationSound[inAppSoundGroup(request.kind)]
  ) {
    return
  }
  const audio = alertElement(request.kind, request.surface)
  audio.currentTime = 0
  void audio.play().catch(() => undefined)
}

/**
 * Preload every alert and wire the alert channel. Returns the unsubscribe
 * function for teardown.
 */
export function installNotificationSound(): () => void {
  for (const surface of ALERT_SURFACES) {
    for (const kind of ALERT_KINDS) {
      alertElement(kind, surface)
    }
  }
  return subscribe('notification:playSound', playNotificationSound)
}
