import { toast } from 'svelte-sonner'
import { speechController } from './speech-controller.svelte'

/**
 * Registry of every live mic input in the renderer. The global voice shortcut
 * hands recording to whichever registered host is actually on view, so each
 * `VoiceInputButton` registers itself here while it is mounted and eligible.
 */
export interface VoiceTriggerHost {
  /** Matches `speechController` target ids so an active recording can find its owner. */
  readonly targetId: string
  /** Wins ties between several equally-visible hosts (overlays score higher). */
  readonly priority: number
  /** Cheap reactive check — a hidden or disabled button never claims the shortcut. */
  readonly eligible: () => boolean
  readonly element: () => HTMLElement | null
  /** Same path as clicking the mic button (start/stop/retry/blocked all handled). */
  readonly activate: () => void
}

interface RegisteredHost extends VoiceTriggerHost {
  lastInteractionAt: number
}

const hosts = new Set<RegisteredHost>()

/** Hosts are compared lexicographically: focused input first, then most
 *  recently interacted-with surface, then explicit priority. Registration
 *  order breaks remaining ties, so comparisons must be strict to keep the
 *  earliest-mounted host winning. */
function beats(candidate: RegisteredHost, incumbent: RegisteredHost | null): boolean {
  if (incumbent === null) return true
  const candidateScope = hostScope(candidate)
  const incumbentScope = hostScope(incumbent)
  const active = document.activeElement
  const candidateHasFocus = active instanceof Element && candidateScope?.contains(active)
  const incumbentHasFocus = active instanceof Element && incumbentScope?.contains(active)
  if (candidateHasFocus !== incumbentHasFocus) return Boolean(candidateHasFocus)
  if (candidate.lastInteractionAt !== incumbent.lastInteractionAt) {
    return candidate.lastInteractionAt > incumbent.lastInteractionAt
  }
  return candidate.priority > incumbent.priority
}

/** The card/composer region around the mic — used for focus and interaction matching. */
function hostScope(host: RegisteredHost): Element | null {
  const element = host.element()
  if (!element) return null
  return element.closest('[data-voice-trigger-root]') ?? element
}

/** True when the element is rendered and genuinely topmost-on-view at its own
 *  position — buttons buried behind another view fail the hit test. */
function visibleOnView(element: HTMLElement): boolean {
  const rects = element.getClientRects()
  if (rects.length === 0) return false
  const rect = rects[0]
  const samplePoints: Array<[number, number]> = []
  for (const fraction of [0.3, 0.5, 0.7]) {
    samplePoints.push([
      Math.min(Math.max(rect.left + rect.width * fraction, 1), window.innerWidth - 1),
      Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1)
    ])
  }
  return samplePoints.some(([x, y]) => {
    const top = document.elementFromPoint(x, y)
    return top !== null && (top === element || element.contains(top))
  })
}

let interactionTrackingInstalled = false

function markInteraction(event: Event): void {
  const target = event.target
  if (!(target instanceof Element)) return
  for (const host of hosts) {
    const scope = hostScope(host)
    if (scope && scope.contains(target)) host.lastInteractionAt = Date.now()
  }
}

function ensureInteractionTracking(): void {
  if (interactionTrackingInstalled) return
  interactionTrackingInstalled = true
  window.addEventListener('focusin', markInteraction, true)
  window.addEventListener('pointerdown', markInteraction, true)
}

function maybeReleaseInteractionTracking(): void {
  if (hosts.size > 0 || !interactionTrackingInstalled) return
  interactionTrackingInstalled = false
  window.removeEventListener('focusin', markInteraction, true)
  window.removeEventListener('pointerdown', markInteraction, true)
}

export function registerVoiceTriggerHost(host: VoiceTriggerHost): () => void {
  const entry: RegisteredHost = { ...host, lastInteractionAt: 0 }
  hosts.add(entry)
  ensureInteractionTracking()
  return () => {
    hosts.delete(entry)
    maybeReleaseInteractionTracking()
  }
}

/** Runs the mic action of whichever input is on view; toggles off the current
 *  recording when one is already running. */
export function triggerPreferredVoiceHost(): void {
  const state = speechController.state.state
  if (state !== 'idle' && state !== 'failed') {
    for (const host of hosts) {
      if (!host.eligible()) continue
      if (speechController.isActiveTarget(host.targetId)) {
        host.activate()
        return
      }
    }
    // Recording from an unmounted target (its view closed mid-recording).
    void speechController.stop()
    return
  }

  let best: RegisteredHost | null = null
  for (const host of hosts) {
    if (!host.eligible()) continue
    const element = host.element()
    if (!element || !element.isConnected || !visibleOnView(element)) continue
    if (beats(host, best)) best = host
  }
  if (best) {
    best.activate()
    return
  }
  toast.info('No microphone input on screen', {
    id: 'voice-shortcut-no-host',
    description: 'Open a chat, comment box, or editor with a mic button to start dictation.',
    duration: 4000
  })
}
