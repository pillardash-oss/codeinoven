/**
 * Keep-alive remote-mode state machine.
 *
 * Models the desktop "away" lifecycle: idle → armed → active → live session →
 * active → idle. Full app quit is blocked while a remote session is live.
 * This module is plain TypeScript so it can be unit-tested directly;
 * `keepAlive.svelte.ts` wraps it in Svelte 5 reactivity.
 */

import type { KeepAlivePhase } from './session-state'
export type { KeepAlivePhase } from './session-state'

export interface KeepAliveState {
  phase: KeepAlivePhase
  since: number
  /** True while a remote session is live — full quit is refused. */
  blockedQuit: boolean
}

export const INITIAL_KEEP_ALIVE: KeepAliveState = {
  phase: 'IDLE',
  since: 0,
  blockedQuit: false
}

export type KeepAliveAction =
  | { type: 'arm' }
  | { type: 'activate' }
  | { type: 'sessionStart' }
  | { type: 'sessionEnd' }
  | { type: 'disarm' }

export function applyKeepAliveAction(
  prev: KeepAliveState,
  action: KeepAliveAction
): KeepAliveState {
  switch (action.type) {
    case 'arm':
      return prev.phase === 'IDLE'
        ? { phase: 'KEEP_ALIVE_ARMED', since: Date.now(), blockedQuit: false }
        : prev
    case 'activate':
      if (prev.phase === 'KEEP_ALIVE_ARMED' || prev.phase === 'IDLE') {
        return { phase: 'KEEP_ALIVE_ACTIVE', since: Date.now(), blockedQuit: false }
      }
      return prev
    case 'sessionStart':
      return { phase: 'REMOTE_SESSION_LIVE', since: Date.now(), blockedQuit: true }
    case 'sessionEnd':
      return prev.phase === 'REMOTE_SESSION_LIVE'
        ? { phase: 'KEEP_ALIVE_ACTIVE', since: Date.now(), blockedQuit: false }
        : prev
    case 'disarm':
      return INITIAL_KEEP_ALIVE
  }
}

/** Minimal session handle used by the tray controller (platform-safe). */
export interface KeepAliveSession {
  readonly phase: KeepAlivePhase
  readonly blockedQuit: boolean
  dispatch(action: KeepAliveAction): void
}

/** Create a standalone keep-alive session without Svelte reactivity. */
export function createKeepAliveSession(): KeepAliveSession {
  let state = INITIAL_KEEP_ALIVE
  return {
    get phase(): KeepAlivePhase {
      return state.phase
    },
    get blockedQuit(): boolean {
      return state.blockedQuit
    },
    dispatch(action: KeepAliveAction): void {
      state = applyKeepAliveAction(state, action)
    }
  }
}
