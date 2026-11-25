import type { CodeInOvenSignInInput } from '../../../lib/ipc/codeinoven-account'
import { CodeInOvenAccountService } from '../../account/codeinoven-account-service'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`${field} is required.`)
  }
  return value
}

function signInInput(raw: unknown): CodeInOvenSignInInput {
  if (typeof raw !== 'object' || raw === null) throw new Error('Sign-in details are required.')
  const record = raw as Record<string, unknown>
  const input: CodeInOvenSignInInput = {
    apiBase: text(record['apiBase'], 'Service address', 2048),
    email: text(record['email'], 'Email', 320).trim(),
    password: text(record['password'], 'Password', 1024)
  }
  if (record['name'] !== undefined) input.name = text(record['name'], 'Name', 200).trim()
  return input
}

/** The desktop's CodeInOven service account: status, sign-in or sign-up, sign-out. */
export function registerCodeInOvenAccountHandlers(
  ctx: Pick<IpcHandlerContext, 'storage' | 'vault'>
): CodeInOvenAccountService {
  const service = new CodeInOvenAccountService(ctx.storage, ctx.vault)
  ipcMain.handle('codeinovenAccount:status', () => service.status())
  ipcMain.handle('codeinovenAccount:signIn', (_, input: unknown) =>
    service.signIn(signInInput(input))
  )
  ipcMain.handle('codeinovenAccount:signOut', () => service.signOut())
  void service.start()
  return service
}
