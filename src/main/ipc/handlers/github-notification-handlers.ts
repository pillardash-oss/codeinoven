import {
  GitHubNotificationsService,
  GitHubNotificationError
} from '../../git/github-notifications-service'
import { validateBoolean } from '../validation/primitives'
import { validateNotificationPageInput, validateNotificationThreadId } from '../ipc-validation'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { GitHubPermissionRequired } from '../../../lib/types'
import type { IpcHandlerContext } from './context'
import { GITHUB_SIGN_IN_URL } from './shared'

/**
 * The listing failure as data when the token cannot read notifications.
 *
 * A 401 or 403 here means the token on file was issued without the
 * `notifications` scope, and a retry cannot grant one: only signing in again
 * can. It is returned rather than thrown because a thrown error crosses IPC as a
 * bare message, leaving the panel unable to tell it apart from a transient
 * failure and with nothing to offer but the retry that cannot work.
 */
function notificationPermissionResult(failure: unknown): GitHubPermissionRequired | null {
  if (!(failure instanceof GitHubNotificationError)) return null
  if (failure.status !== 401 && failure.status !== 403) return null
  return {
    status: 'permission_required',
    message:
      'GitHub would not let CodeInOven read your notifications with the access it was given. ' +
      'Sign in to GitHub again to allow it.',
    settingsUrl: GITHUB_SIGN_IN_URL
  }
}

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
        'GitHub would not let CodeInOven read your notifications with the access it was given. ' +
          'Sign in to GitHub again to allow it.'
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
      const permission = notificationPermissionResult(failure)
      if (permission) return permission
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
