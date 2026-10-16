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
  const candidateHasFocus = focusedWithin(candidateScope)
  const incumbentHasFocus = focusedWithin(incumbentScope)
  if (candidateHasFocus !== incumbentHasFocus) return candidateHasFocus
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

/**
 * True when the caret is inside this scope in the document that scope belongs to.
 *
 * The mic is often not in the app's own document: the comment bubble over a
 * browser page is adopted into a native floating panel, which is a real child
 * window with its own realm. Focus therefore has to be read from the element's
 * own document, and only counts while that whole window actually owns focus, so
 * a panel sitting in the background never outranks the app.
 */
function focusedWithin(scope: Element | null): boolean {
  if (!scope) return false
  const doc = scope.ownerDocument
  if (!doc.hasFocus()) return false
  const active = doc.activeElement
  return active !== null && scope.contains(active)
}

/** True when the element is rendered and genuinely topmost-on-view at its own
 *  position — buttons buried behind another view fail the hit test. The hit test
 *  runs in the element's own document, because a floating panel's mic lives in
 *  the child window's document and viewport, not the app's. */
function visibleOnView(element: HTMLElement): boolean {
  const rects = element.getClientRects()
  if (rects.length === 0) return false
  const rect = rects[0]
  const view = element.ownerDocument.defaultView
  if (!view) return false
  const samplePoints: Array<[number, number]> = []
  for (const fraction of [0.3, 0.5, 0.7]) {
    samplePoints.push([
      Math.min(Math.max(rect.left + rect.width * fraction, 1), view.innerWidth - 1),
      Math.min(Math.max(rect.top + rect.height / 2, 1), view.innerHeight - 1)
    ])
  }
  const doc = element.ownerDocument
  return samplePoints.some(([x, y]) => {
    const top = doc.elementFromPoint(x, y)
    return top !== null && (top === element || element.contains(top))
  })
}

/**
 * Narrows an event target to an element without a same-realm `instanceof`.
 *
 * A floating panel's own nodes come from the child window's realm while the
 * interaction listeners live in the app's, so `target instanceof Element` would
 * reject exactly the nodes this tracking exists to record.
 */
function eventTargetElement(target: EventTarget | null): Element | null {
  if (target === null) return null
  return (target as Node).nodeType === 1 ? (target as Element) : null
}

function markInteraction(event: Event): void {
  const target = eventTargetElement(event.target)
  if (!target) return
  for (const host of hosts) {
    const scope = hostScope(host)
    if (scope && scope.contains(target)) host.lastInteractionAt = Date.now()
  }
}

/**
 * The documents currently worth observing for interaction.
 *
 * Read from the hosts themselves rather than remembered at registration: the
 * comment bubble over a browser page is registered in the app's document and
 * only afterwards adopted into a floating panel, so the document a host lives
 * in is not the one it was registered in.
 */
function hostedDocuments(): Set<Document> {
  const documents = new Set<Document>()
  for (const host of hosts) {
    const element = host.element()
    if (element) documents.add(element.ownerDocument)
  }
  return documents
}

/** Documents whose interaction events are currently observed. */
const observedDocuments = new Map<Document, Window>()

/** Attach to exactly the documents that host a mic, and detach from the rest, so
 *  no listener runs while no recorder is on screen. */
function refreshInteractionTracking(): void {
  const wanted = hostedDocuments()
  for (const [doc, view] of observedDocuments) {
    if (wanted.has(doc)) continue
    view.removeEventListener('focusin', markInteraction, true)
    view.removeEventListener('pointerdown', markInteraction, true)
    observedDocuments.delete(doc)
  }
  for (const doc of wanted) {
    if (observedDocuments.has(doc)) continue
    const view = doc.defaultView
    if (!view) continue
    view.addEventListener('focusin', markInteraction, true)
    view.addEventListener('pointerdown', markInteraction, true)
    observedDocuments.set(doc, view)
  }
}

export function registerVoiceTriggerHost(host: VoiceTriggerHost): () => void {
  const entry: RegisteredHost = { ...host, lastInteractionAt: 0 }
  hosts.add(entry)
  refreshInteractionTracking()
  // A floating panel adopts the mic into a child window after it registers, so
  // the host's document has to be re-read at the move. The surface announcing
  // the move is also genuinely being interacted with, which keeps the bubble's
  // mic ahead of a composer the user happened to touch earlier.
  const scope = hostScope(entry)
  const onDocumentChange = (): void => {
    entry.lastInteractionAt = Date.now()
    refreshInteractionTracking()
  }
  scope?.addEventListener('native-floating-document-change', onDocumentChange)
  return () => {
    scope?.removeEventListener('native-floating-document-change', onDocumentChange)
    hosts.delete(entry)
    refreshInteractionTracking()
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
  // A registered-but-ineligible host means a mic input exists on screen but
  // recording is gated off (no installed ASR model and voice recording not
  // enabled) — say that instead of the generic no-input message.
  if (hosts.size > 0) {
    toast.info('Voice recording is turned off', {
      id: 'voice-shortcut-no-host',
      description:
        'Install a speech-to-text model or enable voice recording in Sound settings to use the shortcut.',
      duration: 4000
    })
    return
  }
  toast.info('No microphone input on screen', {
    id: 'voice-shortcut-no-host',
    description: 'Open a chat, comment box, or editor with a mic button to start dictation.',
    duration: 4000
  })
}
