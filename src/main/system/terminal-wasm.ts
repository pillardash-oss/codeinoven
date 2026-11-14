/**
 * The terminal engine's WebAssembly parser, handed to the renderer as bytes.
 *
 * `ghostty-web` fetches `ghostty-vt.wasm` from beside its own chunk. That works
 * while the renderer is served by the dev server, and fails in a packaged app,
 * where the renderer document is loaded from `file://` and Chromium refuses
 * every fetch there: each terminal surface then fails with "Failed to fetch".
 * The main process reads the very same file out of the app archive instead, and
 * the renderer turns those bytes into a blob URL the library can fetch from any
 * origin.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'

/** Where the parser can sit, most likely first: the build emits it beside the
 *  chunk, and an unpackaged run can still read the installed package. */
function parserCandidates(): string[] {
  const root = app.getAppPath()
  return [
    join(root, 'out', 'renderer', 'assets', 'ghostty-vt.wasm'),
    join(root, 'node_modules', 'ghostty-web', 'ghostty-vt.wasm')
  ]
}

/** Register the one channel the renderer asks for the parser's bytes on. */
export function registerTerminalWasmIpc(): void {
  ipcMain.handle('terminal:wasm', async (): Promise<Uint8Array> => {
    for (const path of parserCandidates()) {
      try {
        const bytes = await readFile(path)
        if (bytes.byteLength > 0) return new Uint8Array(bytes)
      } catch {
        // The next candidate is the other place it can live.
      }
    }
    throw new Error('The terminal parser is missing from this build')
  })
}
