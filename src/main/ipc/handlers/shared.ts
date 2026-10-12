import { GitHubProvider, ProviderHttpError } from '../../providers/github-provider'
import { validateEntityId } from '../ipc-validation'
import type { RepositoryService } from '../../git/repository-service'
import type {
  AttachmentStorageScope,
  GitHubMutationResult,
  GitHubPermissionRequired
} from '../../../lib/types'

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
 * Returned when GitHub will not let this sign-in read the repository.
 *
 * Two causes land here and they need different answers. The app signs in with
 * an OAuth App, so its grant can be revoked or narrowed, and signing in again
 * renews it. But an organization with OAuth app access restrictions refuses
 * every unapproved OAuth App rather than a revoked one, and no amount of
 * signing in clears that: an organization owner has to approve the app under
 * the organization's OAuth app policy. The notice names both, because the
 * second is a dead end that only says "sign in again" hides.
 */
export const GITHUB_REPOSITORY_ACCESS_MESSAGE =
  'GitHub will not let this sign-in read this repository. Sign in again to renew access, or ask an organization owner to approve CodeInOven for that organization.'

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
  if (!(error instanceof ProviderHttpError) || error.status !== 403) return null
  // A 403 is also how GitHub reports a spent rate limit. That is a wait, not a
  // permission the user can grant, so it is not turned into this notice.
  if (/rate limit/iu.test(error.message)) return null
  return {
    status: 'permission_required',
    message: `CodeInOven needs ${accessLabel} for ${owner}/${repo}, and GitHub refused it.`
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
