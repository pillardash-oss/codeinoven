import { GitHubProvider, ProviderHttpError } from '../../providers/github-provider'
import { validateEntityId } from '../ipc-validation'
import type { RepositoryService } from '../../git/repository-service'
import type {
  AttachmentStorageScope,
  GitHubMutationResult,
  GitHubPermissionRequired
} from '../../../lib/types'

/** GitHub App installation link offered when a mutation hits a 403. */
export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/codeinoven/installations/new'

/**
 * Where GitHub's device-flow sign-in happens.
 *
 * Offered as the address a "sign in again" control stands for when the token on
 * file was issued without a scope a view now needs. The code the app is waiting
 * for is entered on this page, so a reader who opens it in a browser is one step
 * from granting the access, and right-clicking the control offers that browser
 * rather than only the click the control performs.
 */
export const GITHUB_SIGN_IN_URL = 'https://github.com/login/device'

/**
 * Returned instead of a raw fetch failure when GitHub could not be reached at
 * all   offline, or a request that outlived the provider's own deadline.
 *
 * It is a transient state rather than a broken feature, so the listing says so
 * instead of rejecting the IPC call, which is also what keeps a network blip out
 * of the main process's handler-error log.
 */
export const GITHUB_TRANSIENT_MESSAGE =
  'GitHub could not be reached right now. This listing will refresh automatically.'

/**
 * Returned when the App cannot see the repository at all (its installation is
 * missing, or its permissions are pending). Actionable, unlike a transient blip.
 */
export const GITHUB_REPOSITORY_ACCESS_MESSAGE =
  'GitHub cannot access this repository. Install the CodeInOven GitHub App on it and grant the requested repository permissions.'

/**
 * Resolve `owner/repo` from a project's origin remote, so a call can target the
 * right repository without asking the user for an extra identity.
 *
 * The provider is constructed with an empty token because the identity comes
 * from the remote URL alone; nothing here is authenticated.
 */
export async function resolveGitHubRemoteIdentity(
  repositoryService: RepositoryService,
  projectPath: string
): Promise<{ owner: string; repo: string }> {
  const remoteUrl = await repositoryService.getRemoteOrigin(projectPath)
  const provider = new GitHubProvider('')
  const identity = provider.resolveRepositoryIdentity(remoteUrl ?? '')
  if (!identity) {
    throw new Error('No GitHub remote (origin) is configured for this project')
  }
  return identity
}
export function canonicalGitHubBranch(branch: string): string {
  return branch
    .replace(/^refs\/remotes\/origin\//u, '')
    .replace(/^refs\/heads\//u, '')
    .replace(/^origin\//u, '')
}

export function githubPermissionRequired(
  error: unknown,
  owner: string,
  repo: string,
  accessLabel = 'Pull requests read and write access'
): GitHubPermissionRequired | null {
  if (
    !(error instanceof ProviderHttpError) ||
    error.status !== 403 ||
    !/resource not accessible by integration/iu.test(error.message)
  ) {
    return null
  }
  return {
    status: 'permission_required',
    message:
      `CodeInOven needs ${accessLabel} for ${owner}/${repo}. ` +
      'Install the GitHub App on this repository or approve its pending permission update.',
    settingsUrl: GITHUB_APP_INSTALL_URL
  }
}

/** Run the industry-standard Skills CLI through the first available package manager. */

export async function runGitHubMutation<T>(
  owner: string,
  repo: string,
  mutation: () => Promise<T>,
  accessLabel?: string
): Promise<GitHubMutationResult<T>> {
  try {
    return { status: 'completed', value: await mutation() }
  } catch (error) {
    const permission = githubPermissionRequired(error, owner, repo, accessLabel)
    if (permission) return permission
    throw error
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function validateAttachmentStorageScope(value: unknown): AttachmentStorageScope {
  if (!isRecord(value) || (value.kind !== 'project' && value.kind !== 'chat')) {
    throw new TypeError('Attachment storage scope is invalid')
  }
  return {
    kind: value.kind,
    projectId: validateEntityId(value.projectId, 'Project ID'),
    threadId: validateEntityId(value.threadId, 'Thread ID')
  }
}

export function isMissingFilesystemError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

export function requireString(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} must be a${allowEmpty ? '' : ' non-empty'} string`)
  }
  return value
}

export function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('Specification version must be a positive safe integer')
  }
  return value
}

export function validateStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value.map((item, index) => requireString(item, `${label}[${index}]`, true))
}
