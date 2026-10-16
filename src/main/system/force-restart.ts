import { app, dialog, Menu, MenuItem, type MenuItemConstructorOptions } from 'electron'
import { Worker } from 'node:worker_threads'
import { APP_NAME } from '../../lib/brand'
import { Logger } from './logger'

const RESTART_GRACE_MS = 15_000
let restartPending = false

/** Native recovery stays usable when the workspace renderer cannot respond. */
export function forceRestartMenuItem(quitApp: () => void): MenuItemConstructorOptions {
  return {
    label: 'Force restart',
    click: () => {
      void requestRestart(quitApp)
    }
  }
}

async function requestRestart(quitApp: () => void): Promise<void> {
  if (restartPending) return
  restartPending = true
  try {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: 'Force restart',
      message: `Restart ${APP_NAME}?`,
      detail:
        'The app will try to shut down cleanly. If it does not finish within 15 seconds, it will be forced to exit. Running tasks will stop and unsaved changes may be lost.',
      buttons: ['Cancel', 'Force restart'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response !== 1) {
      restartPending = false
      return
    }

    // Queue exactly one replacement before starting the normal shutdown. This
    // independent deadline survives a shutdown already in progress and never
    // waits on renderer IPC, storage flushes or service disposal.
    app.relaunch()
    setTimeout(() => app.exit(0), RESTART_GRACE_MS)
    // A timer on the main thread cannot fire if cleanup blocks that thread.
    // This one-shot worker gives Electron one extra second to exit, then kills
    // only this instance. A successful clean exit tears down the worker too.
    try {
      const watchdog = new Worker(
        `const { workerData } = require('node:worker_threads')
         setTimeout(() => process.kill(workerData.pid, 'SIGKILL'), workerData.deadline)`,
        {
          eval: true,
          workerData: { pid: process.pid, deadline: RESTART_GRACE_MS + 1_000 }
        }
      )
      watchdog.on('error', (error) => Logger.error('Restart watchdog failed', error))
      watchdog.unref()
    } catch (error) {
      Logger.error('Could not start restart watchdog', error)
    }
    quitApp()
  } catch (error) {
    restartPending = false
    Logger.error('Could not restart the application', error)
  }
}

/** Preserve the development menu and expose recovery on every desktop platform. */
export function installForceRestartMenu(quitApp: () => void): void {
  const menu = Menu.getApplicationMenu()
  const submenu = menu?.items[0]?.submenu
  if (menu && submenu) {
    const quitIndex = submenu.items.findIndex((item) => item.role === 'quit')
    const index = quitIndex < 0 ? submenu.items.length : quitIndex
    submenu.insert(index, new MenuItem(forceRestartMenuItem(quitApp)))
    Menu.setApplicationMenu(menu)
    return
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: APP_NAME, submenu: [forceRestartMenuItem(quitApp), { role: 'quit' }] }
    ])
  )
}
