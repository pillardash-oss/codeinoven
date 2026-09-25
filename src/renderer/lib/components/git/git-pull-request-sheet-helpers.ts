import { APP_SLUG } from '$shared/brand'
import type { PullRequestReference, PullRequestSummary } from '$shared/types'

export interface PrCreationPreferences {
  head?: string
  base?: string
}

export function preferencesStorageKey(projectId: string, scopeBucketId: string): string {
  return `${APP_SLUG}.pullRequestPreferences.${projectId}.${scopeBucketId}.v1`
}

export function loadPrCreationPreferences(key: string): PrCreationPreferences {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record['head'] === 'string' ? { head: record['head'] } : {}),
      ...(typeof record['base'] === 'string' ? { base: record['base'] } : {})
    }
  } catch {
    return {}
  }
}

export function persistPrCreationPreferences(key: string, update: PrCreationPreferences): void {
  if (typeof window === 'undefined') return
  try {
    const current = loadPrCreationPreferences(key)
    window.localStorage.setItem(key, JSON.stringify({ ...current, ...update }))
  } catch {
    // Preference storage is a convenience; unavailable storage must not block PR creation.
  }
}

export function prDockTitle(pr: PullRequestReference | null, currentTitle: string): string {
  if (pr) return `PR #${pr.number}`
  const trimmed = currentTitle.trim()
  return trimmed.length > 0 ? trimmed : 'New pull request'
}

export function canonicalBranch(value: string): string {
  return value
    .replace(/^refs\/remotes\/origin\//u, '')
    .replace(/^refs\/heads\//u, '')
    .replace(/^origin\//u, '')
}

export function uncategorizedCommitMessage(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, '0')
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `Uncategorized commit ${day} ${time}`
}

export function createdPullRequestSummary(
  reference: PullRequestReference,
  context: { draft: boolean; head: string; base: string }
): PullRequestSummary {
  const now = new Date().toISOString()
  return {
    ...reference,
    state: 'open',
    draft: context.draft,
    authorLogin: '',
    headRef: context.head,
    baseRef: context.base,
    createdAt: now,
    updatedAt: now,
    comments: 0
  }
}

export function parseRemoteIdentity(url: string): { owner: string; repo: string } | null {
  const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url.trim())
  if (!match) return null
  const owner = match[1] ?? ''
  const repo = match[2] ?? ''
  return owner && repo ? { owner, repo } : null
}

export function divergenceResolutionPrompt(head: string, base: string): string {
  return [
    `Resolve the blocked pull request push for branch \`${head}\` into \`${base}\`.`,
    '',
    `The app reported that \`origin/${head}\` has commits missing from the local \`${head}\` branch, so a normal push was rejected.`,
    '',
    'Inspect the repository state and resolve the divergence safely:',
    `1. Check out \`${head}\` if it is not already active.`,
    `2. Fetch \`origin\` and compare \`${head}\` with \`origin/${head}\`.`,
    '3. Reconcile both histories without discarding local or remote commits and without force-pushing.',
    '4. Resolve any conflicts, run the relevant checks, and push the branch normally.',
    '',
    'Do not create the pull request. The draft remains open in the Git panel so the user can finish it there after the branch is synchronized.',
    'Explain what caused the divergence and what you changed.'
  ].join('\n')
}
