/**
 * Real Electron system-Tray host for remote mode.
 *
 * Implements the phase-1 `tray-contract.md` using current, non-deprecated
 * Electron `Tray`/`Menu` APIs: Toggle Remote Mode, a status line, and Quit
 * (disabled while a remote session is live). Clicking the tray restores the
 * main window. All menu behavior matches the contract and the tested
 * `trayController.ts` model.
 */

import { app, Menu, nativeImage, Tray } from 'electron'
import type { RemoteModeStatus } from './remote-types'

export interface RemoteTrayCallbacks {
  onToggle: (enabled: boolean) => void
  onQuit: () => boolean
  onRestore: () => void
}

export interface RemoteTray {
  refresh(status: RemoteModeStatus): void
  notify(title: string, body?: string): void
  destroy(): void
}

const PHASE_LABELS: Record<RemoteModeStatus['phase'], string> = {
  IDLE: 'Remote mode off',
  KEEP_ALIVE_ARMED: 'Ready for remote',
  KEEP_ALIVE_ACTIVE: 'Away — accepting remote sessions',
  REMOTE_SESSION_LIVE: 'Remote session live'
}

export function createRemoteTray(
  iconPath: string,
  callbacks: RemoteTrayCallbacks
): RemoteTray | null {
  let image
  try {
    image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) return null
  } catch {
    return null
  }

  let tray: Tray
  try {
    tray = new Tray(image)
  } catch {
    return null
  }

  let status: RemoteModeStatus = {
    remoteMode: false,
    phase: 'IDLE',
    blockedQuit: false,
    gateway: { listening: false, port: 0, url: null, pairingUrl: null },
    devices: []
  }

  function buildMenu(): void {
    const menu = Menu.buildFromTemplate([
      {
        label: PHASE_LABELS[status.phase],
        enabled: false
      },
      {
        label: status.remoteMode ? 'Disable Remote Mode' : 'Enable Remote Mode',
        type: 'checkbox',
        checked: status.remoteMode,
        click: () => callbacks.onToggle(!status.remoteMode)
      },
      { type: 'separator' },
      {
        label: 'Quit',
        // Closing the app always fully quits — the Tray never blocks it.
        enabled: true,
        click: () => {
          if (callbacks.onQuit()) app.quit()
        }
      }
    ])
    tray.setContextMenu(menu)
    tray.setToolTip(`CodeInOven — ${PHASE_LABELS[status.phase]}`)
  }

  tray.on('click', () => callbacks.onRestore())

  function refresh(next: RemoteModeStatus): void {
    status = next
    buildMenu()
  }

  function notify(title: string, body?: string): void {
    if (tray.isDestroyed()) return
    tray.displayBalloon?.({ title, content: body ?? '' })
  }

  function destroy(): void {
    if (!tray.isDestroyed()) tray.destroy()
  }

  return { refresh, notify, destroy }
}
