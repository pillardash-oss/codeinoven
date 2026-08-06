/**
 * Remote-mode controller (main process).
 *
 * Owns the keep-alive session, the LAN gateway, and the system Tray, and wires
 * quit interception so the desktop stays alive while the user is away. This is
 * the production `TrayHost`/`KeepAliveSession` wiring for the renderer-side
 * modules: the plain `keep-alive.ts` state machine is shared with the renderer
 * via `src/renderer/lib/remote/keep-alive.ts`.
 */

import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { Logger } from '../logger'
import { RemoteGateway } from './remote-gateway'
import { createRemoteTray, type RemoteTray } from './remote-tray'
import type { RemoteModeStatus } from './remote-types'
import { createKeepAliveSession, type KeepAliveSession } from '../../renderer/lib/remote/keep-alive'
import { loadOrCreatePeerSecret } from './peer-secret'
import { RemoteRpcDispatcher } from './remote-rpc'
import { setRemoteEventForwarder } from './remote-event-forwarder'

export interface RemoteModeOptions {
  lanPort: number
  localPort: number
  peerSecret: string | null
  staticRoot: string
  iconPath: string
  /** Optional remote RPC dispatcher that serves the phone chat client. */
  rpc?: RemoteRpcDispatcher | null
}

export const DEFAULT_LAN_PORT = 4455

/** Read a positive integer env var, falling back to `fallback`. */
export function remoteEnvInt(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** Resolve the shared peer auth secret for the gateway, if configured. */
export function remotePeerSecret(): string | null {
  return process.env['PEER_SECRET_AUTH'] ?? process.env['VITE_PEER_SECRET_AUTH'] ?? null
}

export class RemoteModeController {
  private readonly keepAlive: KeepAliveSession = createKeepAliveSession()
  private gateway: RemoteGateway | null = null
  private tray: RemoteTray | null = null
  private readonly lanPort: number
  private readonly localPort: number
  private readonly peerSecret: string | null
  private resolvedPeerSecret: string | null = null
  private readonly staticRoot: string
  private readonly iconPath: string
  private readonly rpc: RemoteRpcDispatcher | null

  constructor(options: RemoteModeOptions) {
    this.lanPort = options.lanPort
    this.localPort = options.localPort
    this.peerSecret = options.peerSecret
    this.staticRoot = options.staticRoot
    this.iconPath = options.iconPath
    this.rpc = options.rpc ?? null
  }

  /**
   * Resolve the peer auth secret used by the gateway.
   *
   * A `PEER_SECRET_AUTH` environment value always wins. When none is supplied
   * (the human-friendly LAN case), a random secret is generated once and
   * persisted under the app user-data dir so pairing stays stable across
   * restarts. The QR pairing URL embeds this secret.
   */
  private async resolvePeerSecret(): Promise<string | null> {
    if (this.peerSecret) return this.peerSecret
    if (this.resolvedPeerSecret !== null) return this.resolvedPeerSecret
    try {
      this.resolvedPeerSecret = await loadOrCreatePeerSecret(
        join(app.getPath('userData'), 'remote-gateway')
      )
      return this.resolvedPeerSecret
    } catch (error) {
      Logger.error('Could not load or create the remote peer secret:', error)
      return null
    }
  }

  get status(): RemoteModeStatus {
    return {
      remoteMode: this.keepAlive.phase !== 'IDLE',
      phase: this.keepAlive.phase,
      blockedQuit: this.keepAlive.blockedQuit,
      gateway: this.gateway?.info() ?? {
        listening: false,
        port: this.lanPort,
        url: null,
        pairingUrl: null
      }
    }
  }

  get remoteModeActive(): boolean {
    return this.keepAlive.phase !== 'IDLE'
  }

  /** Start remote mode: arm keep-alive, launch the gateway, show the Tray. */
  toggleRemoteMode(enabled: boolean): RemoteModeStatus {
    if (enabled && !this.remoteModeActive) {
      this.keepAlive.dispatch({ type: 'arm' })
      void this.startGateway()
      this.ensureTray()
      this.hideWindowToTray()
      Logger.info('Remote mode enabled')
    } else if (!enabled && this.remoteModeActive) {
      this.keepAlive.dispatch({ type: 'disarm' })
      void this.gateway?.stop()
      this.gateway = null
      this.tray?.destroy()
      this.tray = null
      Logger.info('Remote mode disabled')
    }
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /**
   * Ensure the LAN gateway is listening, without toggling the keep-alive/Tray
   * remote-mode behavior. Called when the user opens Settings → Remote so the
   * QR pairing code is immediately scannable. Idempotent.
   */
  async ensureGateway(): Promise<RemoteModeStatus> {
    if (!this.gateway && this.staticRoot) {
      await this.startGateway()
    }
    this.syncTray()
    this.broadcast()
    return this.status
  }

  /** Called by the gateway when a phone peer authenticates or disconnects. */
  onSessionChange(live: boolean): void {
    if (live) {
      this.keepAlive.dispatch({ type: 'sessionStart' })
      this.tray?.notify('Remote session started', 'Your phone is connected to this desktop.')
      this.installEventForwarder()
    } else {
      this.keepAlive.dispatch({ type: 'sessionEnd' })
      this.tray?.notify('Remote session ended', 'The phone disconnected from this desktop.')
      setRemoteEventForwarder(null)
    }
    this.syncTray()
    this.broadcast()
  }

  /** Forward live desktop events to the connected phone peer. */
  private installEventForwarder(): void {
    setRemoteEventForwarder((channel, payload) => {
      this.gateway?.sendToPeer({ rpc: 'event', channel, payload })
    })
  }

  /** Intercept a window close while remote mode is on — hide to tray instead. */
  handleWindowClose(): boolean {
    if (!this.remoteModeActive) return false
    this.hideWindowToTray()
    return true
  }

  /** `window-all-closed`: keep the app alive in the tray while away. */
  handleAllWindowsClosed(): boolean {
    return this.remoteModeActive
  }

  /** `before-quit`: refuse full quit while a remote session is live. */
  handleBeforeQuit(): boolean {
    if (!this.keepAlive.blockedQuit) return false
    this.tray?.notify('Quit blocked', 'A remote session is live on this desktop.')
    return true
  }

  registerIpc(): void {
    ipcMain.handle('remote:getStatus', (): RemoteModeStatus => this.status)
    ipcMain.handle('remote:ensureGateway', (): Promise<RemoteModeStatus> => this.ensureGateway())
    ipcMain.handle(
      'remote:toggle',
      (_event: IpcMainInvokeEvent, enabled: boolean): RemoteModeStatus => {
        return this.toggleRemoteMode(Boolean(enabled))
      }
    )
  }

  private async startGateway(): Promise<void> {
    if (this.gateway) return
    if (!this.staticRoot) {
      Logger.error('Remote gateway not started: renderer static root is not set')
      return
    }
    const peerSecret = await this.resolvePeerSecret()
    const gateway = new RemoteGateway({
      port: this.lanPort,
      localPort: this.localPort,
      peerSecret,
      certificateDir: join(app.getPath('userData'), 'remote-gateway'),
      staticRoot: this.staticRoot,
      handlers: {
        onSessionChange: (live) => this.onSessionChange(live),
        onRpc: this.rpc
          ? async (channel, args) =>
              this.rpc?.dispatch({ id: 0, channel, args }) ?? {
                ok: false,
                message: 'RPC unavailable'
              }
          : undefined
      }
    })
    this.gateway = gateway
    try {
      await gateway.start()
      this.syncTray()
      this.broadcast()
    } catch (error: unknown) {
      Logger.error('Remote gateway failed to start:', error)
      this.gateway = null
      this.broadcast()
    }
  }

  private ensureTray(): void {
    if (this.tray) return
    if (!this.iconPath) return
    this.tray = createRemoteTray(this.iconPath, {
      onToggle: (enabled) => {
        this.toggleRemoteMode(enabled)
      },
      onQuit: () => {
        if (this.keepAlive.blockedQuit) {
          this.tray?.notify('Quit blocked', 'A remote session is live on this desktop.')
          return false
        }
        return true
      },
      onRestore: () => this.restoreWindow()
    })
    this.syncTray()
  }

  private syncTray(): void {
    this.tray?.refresh(this.status)
  }

  private hideWindowToTray(): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) window.hide()
  }

  private restoreWindow(): void {
    const window = BrowserWindow.getAllWindows()[0]
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    }
  }

  private broadcast(): void {
    const status = this.status
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('remote:status', status)
      }
    }
  }
}
