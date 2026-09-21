import { APP_NAME } from '../../lib/brand'
import type { SkillMarketDetail } from '../../lib/types'
import { validateBoundedString } from '../ipc/validation/primitives'

/**
 * Reads of the skills.sh marketplace.
 *
 * Extracted from the utilities IPC handlers because the background skill
 * updater needs the same detail read: a CodeInOven-managed skill's content is
 * refreshed by fetching its `SKILL.md` from the same source the marketplace
 * shows, so install and update cannot disagree about what upstream holds.
 */

/** Leaderboard entry embedded in the marketplace HTML. */
export interface EmbeddedSkillMarketEntry {
  source: string
  skillId: string
  name: string
  installs: number
  weeklyInstalls?: number[]
  installsYesterday?: number
  change?: number
  isOfficial?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function marketEntry(rawEntry: unknown): EmbeddedSkillMarketEntry | null {
  if (!isRecord(rawEntry)) return null
  const source = rawEntry['source']
  const skillId = rawEntry['skillId']
  const name = rawEntry['name']
  const installs = rawEntry['installs']
  if (
    typeof source !== 'string' ||
    typeof skillId !== 'string' ||
    typeof name !== 'string' ||
    typeof installs !== 'number'
  ) {
    return null
  }
  const weeklyInstalls = Array.isArray(rawEntry['weeklyInstalls'])
    ? rawEntry['weeklyInstalls'].filter((value): value is number => typeof value === 'number')
    : undefined
  return {
    source,
    skillId,
    name,
    installs,
    ...(weeklyInstalls?.length ? { weeklyInstalls } : {}),
    ...(typeof rawEntry['installsYesterday'] === 'number'
      ? { installsYesterday: rawEntry['installsYesterday'] }
      : {}),
    ...(typeof rawEntry['change'] === 'number' ? { change: rawEntry['change'] } : {}),
    ...(rawEntry['isOfficial'] === true ? { isOfficial: true } : {})
  }
}

export function publicMarketEntry(entry: EmbeddedSkillMarketEntry) {
  const id = `${entry.source}/${entry.skillId}`
  return { id, ...entry, url: `https://www.skills.sh/${id}` }
}

export async function fetchSkillMarketPage(pathname: string): Promise<string> {
  const response = await fetch(`https://www.skills.sh${pathname}`, {
    headers: { Accept: 'text/html', 'User-Agent': `${APP_NAME}/desktop` },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Skills market request failed (${response.status})`)
  return response.text()
}

export function embeddedLeaderboard(html: string): EmbeddedSkillMarketEntry[] {
  const marker = 'initialSkills\\":'
  const start = html.indexOf(marker)
  const end = html.indexOf('],\\"totalSkills', start)
  if (start < 0 || end < 0) throw new Error('Skills market returned an invalid leaderboard')
  const encoded = html.slice(start + marker.length, end + 1)
  const parsed: unknown = JSON.parse(encoded.replaceAll('\\"', '"').replaceAll('\\\\', '\\'))
  if (!Array.isArray(parsed)) throw new Error('Skills market returned an invalid leaderboard')
  return parsed.flatMap((entry) => {
    const parsedEntry = marketEntry(entry)
    return parsedEntry ? [parsedEntry] : []
  })
}

function jsonLdSkill(html: string): { description: string; installs: number } | null {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/gu)) {
    try {
      const value: unknown = JSON.parse(match[1] ?? '')
      if (
        isRecord(value) &&
        value['@type'] === 'SoftwareApplication' &&
        typeof value['description'] === 'string' &&
        isRecord(value['interactionStatistic']) &&
        typeof value['interactionStatistic']['userInteractionCount'] === 'number'
      ) {
        return {
          description: value['description'],
          installs: value['interactionStatistic']['userInteractionCount']
        }
      }
    } catch {
      // Ignore unrelated malformed structured data and continue looking.
    }
  }
  return null
}

function skillDetailMetadata(html: string): {
  firstSeen: string | null
  audits: Array<{ name: string; status: 'pass' | 'warn' | 'fail' | 'unknown' }>
} {
  const firstSeen =
    html.match(/children\\":\\"First Seen\\"[\s\S]{0,600}?children\\":\\"([^"\\]+)\\"/u)?.[1] ??
    null
  const auditStart = html.indexOf('Security Audits')
  const auditText = auditStart >= 0 ? html.slice(auditStart, auditStart + 12_000) : ''
  const audits: Array<{ name: string; status: 'pass' | 'warn' | 'fail' | 'unknown' }> = []
  for (const match of auditText.matchAll(
    /text-foreground truncate">([^<]+)<\/span>[\s\S]{0,600}?>(Pass|Warn|Fail)<\/span>/gu
  )) {
    const name = match[1]
    const rawStatus = match[2]?.toLowerCase()
    if (!name || (rawStatus !== 'pass' && rawStatus !== 'warn' && rawStatus !== 'fail')) continue
    if (!audits.some((audit) => audit.name === name)) audits.push({ name, status: rawStatus })
  }
  for (const match of auditText.matchAll(
    /children\\":\\"([^"\\]+)\\"[\s\S]{0,500}?children\\":\\"(Pass|Warn|Fail)\\"/gu
  )) {
    const name = match[1]
    const rawStatus = match[2]?.toLowerCase()
    if (!name || (rawStatus !== 'pass' && rawStatus !== 'warn' && rawStatus !== 'fail')) continue
    if (!audits.some((audit) => audit.name === name)) audits.push({ name, status: rawStatus })
  }
  return { firstSeen, audits }
}

async function githubSkillMetadata(
  source: string,
  skillId: string
): Promise<{ repositoryUrl: string; stars: number | null; markdown: string }> {
  const repositoryUrl = `https://github.com/${source}`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `${APP_NAME}/desktop` }
  try {
    const [repositoryResponse, treeResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${source}`, {
        headers,
        signal: AbortSignal.timeout(20_000)
      }),
      fetch(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
        headers,
        signal: AbortSignal.timeout(20_000)
      })
    ])
    const repositoryPayload: unknown = repositoryResponse.ok
      ? await repositoryResponse.json()
      : null
    const treePayload: unknown = treeResponse.ok ? await treeResponse.json() : null
    const stars =
      isRecord(repositoryPayload) && typeof repositoryPayload['stargazers_count'] === 'number'
        ? repositoryPayload['stargazers_count']
        : null
    const defaultBranch =
      isRecord(repositoryPayload) && typeof repositoryPayload['default_branch'] === 'string'
        ? repositoryPayload['default_branch']
        : 'HEAD'
    const tree =
      isRecord(treePayload) && Array.isArray(treePayload['tree']) ? treePayload['tree'] : []
    const skillPath = tree
      .flatMap((entry) =>
        isRecord(entry) && typeof entry['path'] === 'string' ? [entry['path']] : []
      )
      .find((path) => path === `${skillId}/SKILL.md` || path.endsWith(`/${skillId}/SKILL.md`))
    let markdown = ''
    if (skillPath) {
      const rawResponse = await fetch(
        `https://raw.githubusercontent.com/${source}/${defaultBranch}/${skillPath}`,
        { headers: { 'User-Agent': `${APP_NAME}/desktop` }, signal: AbortSignal.timeout(20_000) }
      )
      if (rawResponse.ok) markdown = await rawResponse.text()
    }
    return { repositoryUrl, stars, markdown }
  } catch {
    return { repositoryUrl, stars: null, markdown: '' }
  }
}

const SKILL_MARKET_DETAIL_TTL_MS = 15 * 60 * 1_000
const SKILL_MARKET_DETAIL_CACHE_LIMIT = 100
const skillMarketDetailCache = new Map<string, { detail: SkillMarketDetail; fetchedAt: number }>()
const pendingSkillMarketDetails = new Map<string, Promise<SkillMarketDetail>>()

function skillMarketIdentity(rawId: unknown): {
  id: string
  source: string
  skillId: string
  segments: string[]
} {
  const id = validateBoundedString(rawId, 'Skill market ID', 3, 500)
  const segments = id.split('/').filter(Boolean)
  if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    throw new TypeError('Skill market ID is invalid')
  }
  return {
    id,
    source: segments.slice(0, -1).join('/'),
    skillId: segments.at(-1)!,
    segments
  }
}

export async function loadSkillMarketDetail(rawId: unknown): Promise<SkillMarketDetail> {
  const identity = skillMarketIdentity(rawId)
  const cached = skillMarketDetailCache.get(identity.id)
  if (cached && Date.now() - cached.fetchedAt < SKILL_MARKET_DETAIL_TTL_MS) {
    return structuredClone(cached.detail)
  }
  const pending = pendingSkillMarketDetails.get(identity.id)
  if (pending) return structuredClone(await pending)

  const request = (async (): Promise<SkillMarketDetail> => {
    const githubSource = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.source)
    const [html, github] = await Promise.all([
      fetchSkillMarketPage(`/${identity.segments.map(encodeURIComponent).join('/')}`),
      githubSource
        ? githubSkillMetadata(identity.source, identity.skillId)
        : Promise.resolve({ repositoryUrl: null, stars: null, markdown: '' })
    ])
    const structured = jsonLdSkill(html)
    if (!structured) throw new Error('Skills market returned an invalid skill page')
    const metadata = skillDetailMetadata(html)
    const detail: SkillMarketDetail = {
      ...publicMarketEntry({
        source: identity.source,
        skillId: identity.skillId,
        name: identity.skillId,
        installs: structured.installs
      }),
      description: structured.description,
      repositoryUrl: github.repositoryUrl,
      githubStars: github.stars,
      firstSeen: metadata.firstSeen,
      audits: metadata.audits,
      skillMarkdown: github.markdown
    }
    if (
      !skillMarketDetailCache.has(identity.id) &&
      skillMarketDetailCache.size >= SKILL_MARKET_DETAIL_CACHE_LIMIT
    ) {
      const oldestId = skillMarketDetailCache.keys().next().value
      if (oldestId) skillMarketDetailCache.delete(oldestId)
    }
    skillMarketDetailCache.set(identity.id, { detail, fetchedAt: Date.now() })
    return detail
  })().finally(() => pendingSkillMarketDetails.delete(identity.id))
  pendingSkillMarketDetails.set(identity.id, request)
  return structuredClone(await request)
}
