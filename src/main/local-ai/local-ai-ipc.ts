/**
 * IPC for the Local AI page.
 *
 * The page states which local inference runtimes this machine can drive; the
 * servers themselves run in the main process's local AI registry, and the
 * llama.cpp rows keep their own channels next door.
 */
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { detectLocalAiRuntimes } from './local-ai-runtimes'

export function registerLocalAiIpc(): void {
  ipcMain.handle('localAi:runtimes', () => detectLocalAiRuntimes())
}
