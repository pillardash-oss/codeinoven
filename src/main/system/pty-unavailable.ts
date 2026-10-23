import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'

/**
 * Terminal channels that answer honestly when the PTY engine could not load.
 *
 * `node-pty` is the only compiled native module in the feature graph, and it is
 * compiled on the machine that packages the app. A packaged build whose binary
 * cannot load (a glibc floor newer than the user's distribution, a missing
 * architecture, an ABI mismatch) used to abort the entire feature boot, which
 * cost providers, utilities and every other channel along with terminals.
 *
 * The boot now isolates that import. These handlers keep the terminal contract
 * answerable anyway:

 *  - a create reports why terminals are unavailable, which the terminal panel
 *    already renders as its "Terminal could not start" surface, and
 *  - write, resize, acknowledge and destroy are accepted and dropped, so a
 *    renderer that still holds a terminal session never sees a second error for
 *    every keystroke it forwards.
 */
export function registerUnavailablePtyHandlers(reason: string): void {
  const unavailable = (): never => {
    throw new Error(`Terminals are unavailable in this build: ${reason}`)
  }
  ipcMain.handle('pty:create', unavailable)
  ipcMain.handle('pty:createCommand', unavailable)
  ipcMain.handle('pty:createAction', unavailable)
  ipcMain.handle('pty:createOven', unavailable)
  // A terminal the renderer tears down has nothing to tear down on this side.
  ipcMain.handle('pty:destroy', () => undefined)
  ipcMain.on('pty:ack', () => undefined)
  ipcMain.on('pty:write', () => undefined)
  ipcMain.on('pty:resize', () => undefined)
}
