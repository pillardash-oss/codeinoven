import {
  GitHubNotificationsService,
  GitHubNotificationError
} from '../../git/github-notifications-service'
import { validateBoolean } from '../validation/primitives'
import { validateNotificationPageInput, validateNotificationThreadId } from '../ipc-validation'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { IpcHandlerContext } from './context'

/**
 * Turn a notification failure into a message the panel can act on, without ever
 * echoing the token. A 403 from GitHub's notification endpoints almost always
 * means the OAuth scope or the token type cannot read them, which is a state the
 * user can fix by signing in again.
 */
function describeNotificationFailure(failure: unknown): never {
  if (failure instanceof GitHubNotificationError) {
    if (failure.status === 403) {
      throw new Error(
        'GitHub refused the notifications request. Sign in again to grant the notifications scope.'
      )
    }
    if (failure.status === 404) {
      throw new Error('That GitHub notification thread no longer exists.')
    }
    throw new Error(failure.message)
  }
  throw failure instanceof Error ? failure : new Error('GitHub notifications request failed')
}

/**
 * The signed-in account's GitHub notifications.
 *
 * Notifications are account-wide, not repository-scoped, so these channels take
 * no project: they read and mutate the same threads the account sees on
 * github.com. The token is resolved in the main process only.
 */
export function registerGitHubNotificationHandlers(ctx: IpcHandlerContext): void {
  const service = new GitHubNotificationsService({
    resolveToken: () => ctx.githubAuthService.resolveToken(),
    refreshToken: () => ctx.githubAuthService.resolveToken(true),
    storage: ctx.storage
  })

  ipcMain.handle('githubNotification:page', async (_, input: unknown) => {
    try {
      return await service.listPage(validateNotificationPageInput(input))
    } catch (failure) {
      describeNotificationFailure(failure)
    }
  })

  ipcMain.handle('githubNotification:markRead', async (_, threadId: unknown) => {
    try {
      await service.markRead(validateNotificationThreadId(threadId))
    } catch (failure) {
      describeNotificationFailure(failure)
    }
  })

  ipcMain.handle('githubNotification:markAllRead', async () => {
    try {
      await service.markAllRead()
    } catch (failure) {
      describeNotificationFailure(failure)
    }
  })

  ipcMain.handle(
    'githubNotification:setSubscribed',
    async (_, threadId: unknown, subscribed: unknown) => {
      try {
        await service.setSubscribed(
          validateNotificationThreadId(threadId),
          validateBoolean(subscribed, 'Subscribed')
        )
      } catch (failure) {
        describeNotificationFailure(failure)
      }
    }
  )

  ipcMain.handle('githubNotification:setSaved', async (_, threadId: unknown, saved: unknown) => {
    try {
      return await service.setSaved(
        validateNotificationThreadId(threadId),
        validateBoolean(saved, 'Saved')
      )
    } catch (failure) {
      describeNotificationFailure(failure)
    }
  })

  ipcMain.handle('githubNotification:setDone', async (_, threadId: unknown, done: unknown) => {
    try {
      return await service.setDone(
        validateNotificationThreadId(threadId),
        validateBoolean(done, 'Done')
      )
    } catch (failure) {
      describeNotificationFailure(failure)
    }
  })
}
