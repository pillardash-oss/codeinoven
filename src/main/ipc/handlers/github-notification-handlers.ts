import {
  GitHubNotificationsService,
  GitHubNotificationError,
  GitHubNotificationTokenMissingError
} from '../../git/github-notifications-service'
import { validateBoolean } from '../validation/primitives'
import { validateNotificationPageInput, validateNotificationThreadId } from '../ipc-validation'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type { GitHubNotificationAccessRequired } from '../../../lib/types'
import type { IpcHandlerContext } from './context'

/**
 * What the panel is told when GitHub will not serve notifications to this sign-in.
 *
 * The app signs in with an OAuth App carrying the `notifications` scope, so a
 * refusal here means the grant lost it: it was revoked, or another registration
 * re-issued it. Signing in again asks for the scope afresh, which is why the
 * panel pairs this message with a sign-in control rather than only stating it.
 */
const ACCESS_REFUSED: GitHubNotificationAccessRequired = {
  status: 'access_required',
  message: 'GitHub did not accept this account for notifications.'
}

function accessRequired(message: string): GitHubNotificationAccessRequired {
  return { status: 'access_required', message }
}

/**
 * The listing failure as data when no signed-in account can serve it.
 *
 * Returned rather than thrown because a thrown error crosses IPC as a bare
 * message, leaving the panel unable to tell it apart from a transient failure.
 */
function notificationAccessResult(failure: unknown): GitHubNotificationAccessRequired | null {
  if (failure instanceof GitHubNotificationTokenMissingError) {
    return accessRequired('Sign in to GitHub to read your notifications here.')
  }
  if (failure instanceof GitHubNotificationError) {
    if (failure.status === 401 || failure.status === 403) return ACCESS_REFUSED
  }
  return null
}

/**
 * Turn a notification failure into a message the panel can act on, without ever
 * echoing the token.
 */
function describeNotificationFailure(failure: unknown): never {
  if (failure instanceof GitHubNotificationTokenMissingError) {
    throw new Error('Sign in to GitHub to read your notifications here.')
  }
  if (failure instanceof GitHubNotificationError) {
    if (failure.status === 401 || failure.status === 403) throw new Error(ACCESS_REFUSED.message)
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
 * github.com. They run as the active account, with its token resolved in the main
 * process only, so switching accounts switches whose inbox this is.
 */
export function registerGitHubNotificationHandlers(ctx: IpcHandlerContext): void {
  const service = new GitHubNotificationsService({
    resolveToken: () => ctx.githubAuthService.resolveToken(),
    activeAccountId: () => ctx.githubAuthService.activeAccountId(),
    storage: ctx.storage
  })

  ipcMain.handle('githubNotification:page', async (_, input: unknown) => {
    try {
      return await service.listPage(validateNotificationPageInput(input))
    } catch (failure) {
      const access = notificationAccessResult(failure)
      if (access) return access
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
