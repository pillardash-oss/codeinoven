import { validateBoundedString, validateEntityId } from '../../ipc-validation'
import { trustedIpcMain as ipcMain } from '../../trusted-ipc-main'
import type { IpcHandlerContext } from '../context'

/** GitHub device-flow sign-in and account switching. */
export function registerGithubAuthHandlers(ctx: IpcHandlerContext): void {
  const { githubAuthService } = ctx

  ipcMain.handle('github:authStatus', () => githubAuthService.status())
  ipcMain.handle('github:startDeviceFlow', () => githubAuthService.startDeviceFlow())
  ipcMain.handle('github:poll', async (_, deviceCode: unknown) =>
    githubAuthService.pollAccessToken(validateBoundedString(deviceCode, 'Device code', 1, 256))
  )
  ipcMain.handle('github:switchAccount', async (_, accountId: unknown) =>
    githubAuthService.switchAccount(validateEntityId(accountId, 'GitHub account ID'))
  )
  ipcMain.handle('github:logout', async () => {
    await githubAuthService.logout()
    return githubAuthService.status()
  })
}
