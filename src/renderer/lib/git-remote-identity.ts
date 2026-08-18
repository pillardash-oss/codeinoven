/**
 * Parses a git remote URL into the hosting platform (for its brand icon) and
 * the repository path (e.g. `owner/repo`) to show instead of the raw URL.
 */

export type GitRemotePlatform = 'github' | 'gitlab'

export interface GitRemoteIdentity {
  /** Brand icon to show — unrecognized/self-hosted hosts default to GitHub. */
  platform: GitRemotePlatform
  /** `owner/repo` (or deeper group path on GitLab), no `.git` suffix. */
  path: string
}

export function parseRemoteIdentity(url: string | undefined | null): GitRemoteIdentity | null {
  const trimmed = url?.trim()
  if (!trimmed) return null

  const sshMatch = /^(?:ssh:\/\/)?[\w.-]+@([^:/]+)[:/](.+?)(?:\.git)?\/?$/u.exec(trimmed)
  const httpMatch = /^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/u.exec(trimmed)
  const match = sshMatch ?? httpMatch
  const host = match?.[1]?.toLowerCase() ?? ''
  const path = match?.[2] ?? ''
  if (!host || !path) return null

  const platform: GitRemotePlatform = host.includes('gitlab') ? 'gitlab' : 'github'
  return { platform, path }
}
