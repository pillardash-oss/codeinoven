/**
 * Reactive keep-alive controller.
 *
 * Svelte 5 wrapper over the `keep-alive.ts` state machine so the tray wiring
 * and the phone-client status UI can observe the phase reactively. Implements
 * the same `KeepAliveSession` interface as `createKeepAliveSession()`.
 */

import {
  applyKeepAliveAction,
  INITIAL_KEEP_ALIVE,
  type KeepAliveAction,
  type KeepAlivePhase,
  type KeepAliveSession,
  type KeepAliveState
} from './keep-alive'

export class KeepAliveController implements KeepAliveSession {
  state = $state<KeepAliveState>(INITIAL_KEEP_ALIVE)

  get phase(): KeepAlivePhase {
    return this.state.phase
  }

  get blockedQuit(): boolean {
    return this.state.blockedQuit
  }

  dispatch(action: KeepAliveAction): void {
    this.state = applyKeepAliveAction(this.state, action)
  }
}

export const keepAliveController = new KeepAliveController()
