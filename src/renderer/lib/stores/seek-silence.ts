import { invoke } from '$lib/ipc.svelte'
import { contextSidebarState } from './context-sidebar.svelte'

/**
 * How long a seek keeps a page silent after its last move.
 *
 * A held arrow repeats every few tens of milliseconds and a drag reports every
 * position it crosses, so the silence has to outlast the gap between two moves;
 * releasing it any sooner makes the audio stutter back in mid-scrub.
 */
const SILENCE_MS = 300

/**
 * The pages a seek is holding silent, and the sound each one had before.
 *
 * A composition is a page rather than an element, so the only way to keep a scrub
 * quiet is the tab's own mute. The reader's setting is what the tab is given back
 * afterwards: a page they had muted stays muted, and one they were listening to
 * is heard again once the head settles.
 */
const holds = new Map<string, { restoreTo: boolean; timer: ReturnType<typeof setTimeout> }>()

/** Take one tab's sound away for the length of a seek. */
export function silenceTabForSeek(tabId: string): void {
  const holding = holds.get(tabId)
  if (holding) {
    clearTimeout(holding.timer)
    holding.timer = setTimeout(() => releaseTabSeekSilence(tabId), SILENCE_MS)
    return
  }
  const restoreTo = contextSidebarState.browserRuntime(tabId).muted
  const timer = setTimeout(() => releaseTabSeekSilence(tabId), SILENCE_MS)
  holds.set(tabId, { restoreTo, timer })
  if (restoreTo) return
  void invoke('browser:setMuted', tabId, true).catch(() => releaseTabSeekSilence(tabId))
}

/** The head has settled: give the tab back the sound the reader had on it. */
export function releaseTabSeekSilence(tabId: string): void {
  const holding = holds.get(tabId)
  if (!holding) return
  holds.delete(tabId)
  clearTimeout(holding.timer)
  if (holding.restoreTo) return
  void invoke('browser:setMuted', tabId, false).catch(() => {})
}
