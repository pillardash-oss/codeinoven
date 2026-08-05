export interface ProjectLocationSource {
  name: string
  path?: string
  source?: 'local' | 'ssh'
  host?: string
}

function normalizedProjectName(name: string): string {
  return name.trim().toLowerCase()
}

export function hasProjectNameCollision(
  project: Pick<ProjectLocationSource, 'name'>,
  projects: readonly Pick<ProjectLocationSource, 'name'>[]
): boolean {
  const name = normalizedProjectName(project.name)
  if (!name) return false

  let matches = 0
  for (const candidate of projects) {
    if (normalizedProjectName(candidate.name) !== name) continue
    matches += 1
    if (matches > 1) return true
  }
  return false
}

function abbreviateHomePath(path: string): string {
  const normalized = path.trim().replace(/\\/gu, '/')
  return normalized
    .replace(/^\/(?:Users|home)\/[^/]+(?=\/)/u, '~')
    .replace(/^[A-Za-z]:\/Users\/[^/]+(?=\/)/u, '~')
}

export function projectLocationLabel(project: ProjectLocationSource): string {
  const path = project.path?.trim() ? abbreviateHomePath(project.path) : ''
  const host = project.host?.trim() ?? ''

  if (project.source === 'ssh' || host) {
    if (host && path && path !== host) return `${host}:${path}`
    return host || path || 'SSH'
  }

  return path
}

export function projectIdentityTitle(project: ProjectLocationSource): string {
  const location = projectLocationLabel(project)
  return location ? `${project.name}\n${location}` : project.name
}

/**
 * Reduce a git remote `origin` URL to a compact `owner/repo` identity.
 * Handles `https://host/owner/repo(.git)` and scp-style
 * `git@host:owner/repo(.git)` remotes; falls back to the trimmed URL.
 */
export function remoteOriginLabel(url: string): string {
  const cleaned = url.trim().replace(/\.git$/u, '')
  const httpsMatch = cleaned.match(/^https?:\/\/[^/]+\/(.+)$/u)
  if (httpsMatch) return httpsMatch[1]
  const scpMatch = cleaned.match(/^(?:[^@]+@)?[^:]+:(.+)$/u)
  if (scpMatch) return scpMatch[1]
  return cleaned
}
