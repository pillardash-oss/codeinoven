import { ProviderHttpError } from '../../providers/github-provider'
import { validateEntityId } from '../ipc-validation'
import type {
  AttachmentStorageScope,
  GitHubMutationResult,
  GitHubPermissionRequired
} from '../../../lib/types'

/** GitHub App installation link offered when a mutation hits a 403. */
export const GITHUB_APP_INSTALL_URL = 'https://github.com/apps/codeinoven/installations/new'
export function canonicalGitHubBranch(branch: string): string {
  return branch
    .replace(/^refs\/remotes\/origin\//u, '')
    .replace(/^refs\/heads\//u, '')
    .replace(/^origin\//u, '')
}

export function githubPermissionRequired(
  error: unknown,
  owner: string,
  repo: string
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
      `CodeInOven needs Pull requests read and write access for ${owner}/${repo}. ` +
      'Install the GitHub App on this repository or approve its pending permission update.',
    settingsUrl: GITHUB_APP_INSTALL_URL
  }
}

/** Run the industry-standard Skills CLI through the first available package manager. */

export async function runGitHubMutation<T>(
  owner: string,
  repo: string,
  mutation: () => Promise<T>
): Promise<GitHubMutationResult<T>> {
  try {
    return { status: 'completed', value: await mutation() }
  } catch (error) {
    const permission = githubPermissionRequired(error, owner, repo)
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
