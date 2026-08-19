/**
 * Desktop Tray controller — implements the phase-1 `tray-contract.md`.
 *
 * The renderer cannot construct an Electron `Tray` directly, so the controller
 * renders through an injected `TrayHost` adapter (implemented as a main-process
 * IPC host in a real deployment) and drives a platform-safe `KeepAliveSession`.
 * Menu labels, status lines, LAN advertising hooks, remote-disconnect
 * notifications, and quit-blocking semantics below match the contract exactly.
 */

import type { KeepAlivePhase, KeepAliveSession } from './keep-alive'

export interface TrayMenuItem {
  id: string
  label: string
  enabled: boolean
  checked: boolean
  onClick: () => void
}

export interface TrayMenuModel {
  title: string
  items: TrayMenuItem[]
}

export interface TrayHost {
  create(menu: TrayMenuModel): void
  destroy(): void
  notify(title: string, body?: string): void
  setTooltip(text: string): void
}

export interface SessionDisplay {
  setKeepAlive(phase: KeepAlivePhase): void
  statusText(): string
}

export interface TrayControllerOptions {
  host: TrayHost
  keepAlive: KeepAliveSession
  sessionDisplay: SessionDisplay
  /** Advertise the LAN peer (reuses phase-2 discovery/transport wiring). */
  advertise?: () => void
  /** Stop advertising the LAN peer. */
  stopAdvertise?: () => void
  /** Called when a live remote session ends. */
  onRemoteDisconnect?: (reason: string) => void
}

export const PHASE_LABELS: Record<KeepAlivePhase, string> = {
  IDLE: 'Remote mode off',
  KEEP_ALIVE_ARMED: 'Ready for remote',
  KEEP_ALIVE_ACTIVE: 'Away — accepting remote sessions',
  REMOTE_SESSION_LIVE: 'Remote session live'
}

export class TrayController {
  private readonly host: TrayHost
  private readonly keepAlive: KeepAliveSession
  private readonly sessionDisplay: SessionDisplay
  private readonly advertise: () => void
  private readonly stopAdvertise: () => void
  private readonly onRemoteDisconnect: (reason: string) => void

  constructor(options: TrayControllerOptions) {
    this.host = options.host
    this.keepAlive = options.keepAlive
    this.sessionDisplay = options.sessionDisplay
    this.advertise = options.advertise ?? (() => undefined)
    this.stopAdvertise = options.stopAdvertise ?? (() => undefined)
    this.onRemoteDisconnect = options.onRemoteDisconnect ?? (() => undefined)
  }

  get remoteModeOn(): boolean {
    return this.keepAlive.phase !== 'IDLE'
  }

  /** Toggle keep-alive remote mode on/off and rebuild the tray menu. */
  toggleRemoteMode(): void {
    if (this.remoteModeOn) {
      this.keepAlive.dispatch({ type: 'disarm' })
      this.sessionDisplay.setKeepAlive('IDLE')
      this.stopAdvertise()
      this.host.notify('Remote mode disabled')
    } else {
      this.keepAlive.dispatch({ type: 'arm' })
      this.sessionDisplay.setKeepAlive('KEEP_ALIVE_ARMED')
      this.advertise()
      this.host.notify('Remote mode enabled')
    }
    this.refresh()
  }

  /** A remote phone session has connected to this desktop. */
  sessionStarted(): void {
    this.keepAlive.dispatch({ type: 'sessionStart' })
    this.sessionDisplay.setKeepAlive('REMOTE_SESSION_LIVE')
    this.host.setTooltip(`${PHASE_LABELS['REMOTE_SESSION_LIVE']} — quit blocked`)
    this.host.notify('Remote session started', 'Your phone is connected to this desktop.')
    this.refresh()
  }

  /** The remote session ended (phone disconnected or user returned). */
  sessionEnded(reason: string): void {
    const wasLive = this.keepAlive.phase === 'REMOTE_SESSION_LIVE'
    this.keepAlive.dispatch({ type: 'sessionEnd' })
    if (!wasLive) return
    this.sessionDisplay.setKeepAlive('KEEP_ALIVE_ACTIVE')
    this.onRemoteDisconnect(reason)
    this.host.notify('Remote session ended', reason)
    this.refresh()
  }

  /** Attempt a full app quit; refused while a remote session is live. */
  requestQuit(): boolean {
    if (this.keepAlive.blockedQuit) {
      this.host.notify('Quit blocked', 'A remote session is live on this desktop.')
      this.refresh()
      return false
    }
    return true
  }

  /** Rebuild the tray menu from the current keep-alive/route state. */
  refresh(): void {
    const phase = this.keepAlive.phase
    const items: TrayMenuItem[] = [
      {
        id: 'toggle-remote',
        label: this.remoteModeOn ? 'Disable Remote Mode' : 'Enable Remote Mode',
        enabled: true,
        checked: this.remoteModeOn,
        onClick: () => this.toggleRemoteMode()
      },
      {
        id: 'status',
        label: `${PHASE_LABELS[phase]} · ${this.sessionDisplay.statusText()}`,
        enabled: false,
        checked: false,
        onClick: () => undefined
      },
      {
        id: 'quit',
        label: 'Quit',
        enabled: !this.keepAlive.blockedQuit,
        checked: false,
        onClick: () => this.requestQuit()
      }
    ]
    this.host.create({ title: `CodeInOven — ${PHASE_LABELS[phase]}`, items })
    this.host.setTooltip(PHASE_LABELS[phase])
  }
}
