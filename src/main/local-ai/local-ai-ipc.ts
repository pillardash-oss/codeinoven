/**
 * IPC for the Local AI page.
 *
 * The page states which local inference runtimes this machine can drive; the
 * servers themselves run in the main process's local AI registry, and the
 * llama.cpp rows keep their own channels next door.
 */
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { detectLocalAiRuntimes } from './local-ai-runtimes'
import { sharedLocalAiRuntimeRegistry } from './local-ai-runtime-registry'

export function registerLocalAiIpc(): void {
  ipcMain.handle('localAi:runtimes', () => detectLocalAiRuntimes())
  // The page's "Unload now": the user overriding the idle window, which the
  // confirmation card warns about before it reaches here.
  ipcMain.handle('localAi:unloadNow', () => sharedLocalAiRuntimeRegistry().unloadNow())
}
