import {
  GitHubNotificationsService,
  GitHubNotificationError,
  GitHubNotificationTokenMissingError,
  notificationScopesAllowRead,
  type GitHubTokenInspection
} from '../../git/github-notifications-service'
import { validateBoolean } from '../validation/primitives'
import {
  validateNotificationPageInput,
  validateNotificationThreadId,
  validateNotificationToken
} from '../ipc-validation'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type {
  GitHubNotificationTokenRequired,
  GitHubNotificationTokenStatus
} from '../../../lib/types'
import type { IpcHandlerContext } from './context'
import { GITHUB_TOKEN_CREATE_URL } from './shared'

/**
 * Vault ref the notification token is stored under.
 *
 * Account-wide rather than per project, and its own ref rather than the git
 * credential's: reading notifications is a property of the account, not of the
 * checkout the panel happens to be standing in.
 */
const NOTIFICATION_TOKEN_REF = 'github_notifications_token'

/** The token is not connected yet, or GitHub would not accept the one on file. */
const MISSING_TOKEN_MESSAGE =
  'Notifications are read with a GitHub personal access token. Connect one to read and act on ' +
  'your notifications here.'

const REFUSED_TOKEN_MESSAGE =
  'GitHub would not accept the notification token on file. Connect a token again to keep reading ' +
  'your notifications here.'

/** The token could not read notifications when it was checked. */
const WRONG_SCOPE_MESSAGE =
  'That token cannot read notifications. Create one with the notifications scope and connect it.'

/** Status reported when no token is stored, or the stored one is dead. */
const DISCONNECTED: GitHubNotificationTokenStatus = {
  connected: false,
  login: null,
  scopes: null,
  canReadNotifications: false,
  createTokenUrl: GITHUB_TOKEN_CREATE_URL
}

function tokenRequired(message: string): GitHubNotificationTokenRequired {
  return { status: 'token_required', message, createTokenUrl: GITHUB_TOKEN_CREATE_URL }
}

/**
 * The listing failure as data when no usable token can serve it.
 *
 * GitHub refuses the app's own GitHub App token here   every notification
 * endpoint is marked `enabledForGitHubApps: false` in GitHub's REST description
 *   so a retry or another sign-in cannot fix this one. The state is returned
 * rather than thrown because a thrown error crosses IPC as a bare message,
 * leaving the panel unable to tell it apart from a transient failure.
 */
function notificationAccessResult(failure: unknown): GitHubNotificationTokenRequired | null {
  if (failure instanceof GitHubNotificationTokenMissingError) {
    return tokenRequired(MISSING_TOKEN_MESSAGE)
  }
  if (failure instanceof GitHubNotificationError) {
    if (failure.status === 401 || failure.status === 403) {
      return tokenRequired(REFUSED_TOKEN_MESSAGE)
    }
  }
  return null
}

/**
 * Turn a notification failure into a message the panel can act on, without ever
 * echoing the token.
 */
function describeNotificationFailure(failure: unknown): never {
  if (failure instanceof GitHubNotificationTokenMissingError) {
    throw new Error(MISSING_TOKEN_MESSAGE)
  }
  if (failure instanceof GitHubNotificationError) {
    if (failure.status === 401 || failure.status === 403) {
      throw new Error(REFUSED_TOKEN_MESSAGE)
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
 * github.com. They run on the token the user connected for them, resolved from
 * the vault in the main process only.
 */
export function registerGitHubNotificationHandlers(ctx: IpcHandlerContext): void {
  const readToken = async (): Promise<string | null> => {
    if (!(await ctx.vault.exists(NOTIFICATION_TOKEN_REF))) return null
    return ctx.vault.resolve(NOTIFICATION_TOKEN_REF)
  }

  const service = new GitHubNotificationsService({
    resolveToken: () => readToken(),
    storage: ctx.storage
  })

  /**
   * The status of the token on file, checked against GitHub.
   *
   * A token GitHub refuses with a 401 can never work again, so it is dropped here
   *   the panel then asks for a fresh one instead of listing an error it cannot
   * act on.
   */
  const tokenStatus = async (): Promise<GitHubNotificationTokenStatus> => {
    const token = await readToken()
    if (!token) return DISCONNECTED
    try {
      const inspection = await service.inspectToken(token)
      return {
        connected: true,
        login: inspection.login,
        scopes: inspection.scopes,
        canReadNotifications: notificationScopesAllowRead(inspection.scopes),
        createTokenUrl: GITHUB_TOKEN_CREATE_URL
      }
    } catch (failure) {
      if (failure instanceof GitHubNotificationError && failure.status === 401) {
        await ctx.vault.remove(NOTIFICATION_TOKEN_REF)
        return DISCONNECTED
      }
      throw failure instanceof Error
        ? failure
        : new Error('The notification token could not be checked')
    }
  }

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

  ipcMain.handle('githubNotification:tokenStatus', async () => tokenStatus())

  ipcMain.handle('githubNotification:setToken', async (_, token: unknown) => {
    const candidate = validateNotificationToken(token)
    let inspection: GitHubTokenInspection
    try {
      inspection = await service.inspectToken(candidate)
    } catch (failure) {
      if (failure instanceof GitHubNotificationError && failure.status === 401) {
        throw new Error(
          'GitHub did not accept that token. Check that you pasted the whole token.',
          { cause: failure }
        )
      }
      throw failure instanceof Error
        ? failure
        : new Error('That token could not be checked', { cause: failure })
    }
    if (!notificationScopesAllowRead(inspection.scopes)) {
      throw new Error(WRONG_SCOPE_MESSAGE)
    }
    await ctx.vault.save(candidate, NOTIFICATION_TOKEN_REF)
    return {
      connected: true,
      login: inspection.login,
      scopes: inspection.scopes,
      canReadNotifications: true,
      createTokenUrl: GITHUB_TOKEN_CREATE_URL
    } satisfies GitHubNotificationTokenStatus
  })

  ipcMain.handle('githubNotification:removeToken', async () => {
    await ctx.vault.remove(NOTIFICATION_TOKEN_REF)
    return DISCONNECTED
  })
}
