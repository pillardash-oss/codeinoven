import { APP_NAME } from '../../lib/brand'

/**
 * What upstream currently holds for one skill, in the exact form the skills CLI
 * itself compares.
 *
 * For a GitHub source that is the git tree sha of the skill's folder   the same
 * value the CLI writes as `skillFolderHash` in its global lock, so a check
 * agrees with `skills update` instead of inventing a second notion of "changed".
 * For a well-known (domain) source it is the index digest the CLI records as
 * `wellKnownDigest`. Both are captured at install time and compared later.
 */

export interface UpstreamSkillVersion {
  /** Git tree sha of the skill folder, or the well-known index digest. */
  hash: string
  /** GitHub sources only: the skill's `SKILL.md` path inside the repository. */
  skillPath: string | null
}

export type SkillSourceType = 'github' | 'well-known'

const FETCH_TIMEOUT_MS = 20_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function githubHeaders(githubToken: string | null): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': `${APP_NAME}/desktop`,
    ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {})
  }
}

/** Percent-encode a repository path without escaping its separators. */
function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** The folder that holds a `SKILL.md` path, using the CLI's own rule. */
function skillFolder(skillPath: string): string {
  return skillPath.replace(/\/SKILL\.md$/iu, '')
}

/**
 * One folder's own tree sha. GitHub resolves `HEAD:<path>` to that subtree, so
 * the response is a few hundred bytes instead of the repository's whole tree,
 * and its top-level `sha` is exactly the value a check compares against.
 */
async function fetchFolderSha(
  source: string,
  folder: string,
  githubToken: string | null
): Promise<string | null> {
  if (!folder) return null
  try {
    const response = await fetch(
      `https://api.github.com/repos/${source}/git/trees/HEAD:${encodePath(folder)}`,
      { headers: githubHeaders(githubToken), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    )
    if (!response.ok) return null
    const payload: unknown = await response.json()
    return isRecord(payload) && typeof payload['sha'] === 'string' ? payload['sha'] : null
  } catch {
    return null
  }
}

/**
 * Find a skill whose path is not known yet, or whose folder moved upstream.
 * This is the one call that reads a whole repository tree, and it is only made
 * when the recorded path cannot be resolved.
 */
async function discoverSkill(
  source: string,
  skillId: string,
  githubToken: string | null
): Promise<UpstreamSkillVersion | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`,
      { headers: githubHeaders(githubToken), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    )
    if (!response.ok) return null
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload['tree'])) return null
    const folderShas = new Map<string, string>()
    const blobPaths: string[] = []
    for (const entry of payload['tree']) {
      if (!isRecord(entry)) continue
      const path = entry['path']
      const sha = entry['sha']
      if (typeof path !== 'string' || typeof sha !== 'string') continue
      if (entry['type'] === 'tree') folderShas.set(path, sha)
      else if (entry['type'] === 'blob') blobPaths.push(path)
    }
    const matches = blobPaths
      .filter((path) => path === `${skillId}/SKILL.md` || path.endsWith(`/${skillId}/SKILL.md`))
      // Shallowest match wins, so a repository that also keeps a nested copy of
      // the same skill under a fixture directory still resolves to the real one.
      .sort((left, right) => left.split('/').length - right.split('/').length)
    const skillPath = matches[0]
    if (!skillPath) return null
    const hash = folderShas.get(skillFolder(skillPath))
    return hash ? { hash, skillPath } : null
  } catch {
    return null
  }
}

/** Read the well-known index digest a domain publishes for one skill. */
async function fetchWellKnownDigest(
  source: string,
  skillId: string
): Promise<UpstreamSkillVersion | null> {
  for (const wellKnownPath of ['.well-known/agent-skills', '.well-known/skills']) {
    try {
      const response = await fetch(`https://${source}/${wellKnownPath}/index.json`, {
        headers: { Accept: 'application/json', 'User-Agent': `${APP_NAME}/desktop` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) continue
      const payload: unknown = await response.json()
      if (!isRecord(payload) || !Array.isArray(payload['skills'])) continue
      for (const entry of payload['skills']) {
        if (!isRecord(entry) || entry['name'] !== skillId) continue
        const digest = entry['digest']
        // A v1 index lists files but publishes no digest, so there is nothing to
        // compare later; try the other well-known location before giving up.
        if (typeof digest === 'string' && digest) return { hash: digest, skillPath: null }
      }
    } catch {
      // Try the next well-known location.
    }
  }
  return null
}

/**
 * Read upstream's current version of one skill. A known path costs one small
 * subtree read; anything else falls back to discovering the skill in the
 * repository tree.
 */
export async function fetchUpstreamSkillVersion(options: {
  source: string
  sourceType: SkillSourceType
  skillId: string
  /** Path resolved at install time, when there is one. */
  skillPath?: string | null
  githubToken?: string | null
}): Promise<UpstreamSkillVersion | null> {
  if (options.sourceType === 'well-known') {
    return fetchWellKnownDigest(options.source, options.skillId)
  }
  const known = options.skillPath ?? null
  if (known) {
    const sha = await fetchFolderSha(
      options.source,
      skillFolder(known),
      options.githubToken ?? null
    )
    if (sha) return { hash: sha, skillPath: known }
  }
  return discoverSkill(options.source, options.skillId, options.githubToken ?? null)
}
