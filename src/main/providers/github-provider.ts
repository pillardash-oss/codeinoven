import type { GitRepositoryIdentity, PrDraft, PullRequestReference } from '../../lib/types'
import type {
  GitProvider,
  ListPullRequestsInput,
  MergePullRequestInput
} from '../git-provider.interface'
import { Logger } from '../logger'

/** Default provider base URL — the public GitHub.com REST API the app already calls. */
export const GITHUB_API_BASE_URL = 'https://api.github.com'

/** Env var for self-hosted GitHub/GitLab API base URLs (deferred; must be explicit). */
export const PROVIDER_API_BASE_URL_ENV = 'CODEINOVEN_GIT_PROVIDER_API_BASE_URL'

/** Network timeout so a slow provider never hangs the UI. */
const PROVIDER_FETCH_TIMEOUT_MS = 15_000

const GITHUB_API_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'CodeInOven'

/**
 * GitHub-first REST adapter.
 *
 * The token is resolved from `SecretVault` in the main process only and is
 * never serialized into IPC payloads or logs. Error surfaces are sanitized so
 * the `Authorization` header can never leak.
 */
export class GitHubProvider implements GitProvider {
  constructor(
    private readonly token: string,
    private readonly baseUrl = resolveProviderBaseUrl()
  ) {}

  async createPullRequest(draft: PrDraft): Promise<PullRequestReference> {
    const body = {
      title: draft.title,
      head: draft.head,
      base: draft.base,
      ...(draft.body !== undefined ? { body: draft.body } : {}),
      ...(draft.draft !== undefined ? { draft: draft.draft } : {})
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(draft.owner)}/${encodeURIComponent(draft.repo)}/pulls`,
      { method: 'POST', body: JSON.stringify(body) }
    )
    return this.toReference(response)
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<PullRequestReference> {
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/merge`,
      { method: 'PUT', body: JSON.stringify({ merge_method: input.method }) }
    )
    const record = Array.isArray(response) ? {} : response
    return {
      number: input.pullNumber,
      url: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
      title: this.readString(record, 'title') ?? `Pull request #${input.pullNumber}`
    }
  }

  async listPullRequests(input: ListPullRequestsInput): Promise<PullRequestReference[]> {
    const query = input.state ? `?state=${encodeURIComponent(input.state)}` : ''
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls${query}`,
      { method: 'GET' }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReference[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const number = typeof record['number'] === 'number' ? record['number'] : 0
      if (number <= 0) return []
      return [
        {
          number,
          url: `https://github.com/${input.owner}/${input.repo}/pull/${number}`,
          title: typeof record['title'] === 'string' ? record['title'] : `Pull request #${number}`
        }
      ]
    })
  }

  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null {
    const url = remoteUrl.trim()
    if (!url) return null
    const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url)
    if (!match) return null
    const owner = match[1] ?? ''
    const repo = match[2] ?? ''
    if (!owner || !repo) return null
    return { owner, repo }
  }

  /** Perform a JSON fetch against the provider, sanitizing errors. */
  private async request(
    path: string,
    init: RequestInit
  ): Promise<Record<string, unknown> | unknown[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: GITHUB_API_ACCEPT,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': USER_AGENT,
          Authorization: `Bearer ${this.token}`,
          ...init.headers
        },
        signal: controller.signal
      })
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new Error(`Provider returned HTTP ${response.status}${message ? `: ${message}` : ''}`)
      }
      if (response.status === 204) return {}
      return (await response.json()) as Record<string, unknown> | unknown[]
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Provider request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  /** Read a provider error body's `message` field without touching headers. */
  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (typeof body['message'] === 'string') return body['message'].slice(0, 500)
    } catch {
      // Non-JSON error body — fall through to the status-only message.
    }
    return ''
  }

  private toReference(payload: Record<string, unknown> | unknown[]): PullRequestReference {
    const record = Array.isArray(payload) ? {} : (payload as Record<string, unknown>)
    const number = this.readNumber(record, 'number')
    const htmlUrl = this.readString(record, 'html_url')
    const url =
      htmlUrl ??
      (number > 0
        ? `https://github.com/${this.readString(record, 'owner') ?? ''}/${this.readString(record, 'repo') ?? ''}/pull/${number}`
        : '')
    return {
      number,
      url,
      title: this.readString(record, 'title') ?? (number > 0 ? `Pull request #${number}` : '')
    }
  }

  private readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  private readNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key]
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
  }
}

/** Resolve the provider base URL, honoring the env contract with GitHub.com default. */
export function resolveProviderBaseUrl(): string {
  const configured = process.env[PROVIDER_API_BASE_URL_ENV]?.trim()
  if (!configured) return GITHUB_API_BASE_URL
  const normalized = configured.replace(/\/+$/u, '')
  if (/^https?:\/\/localhost(:\d+)?$/u.test(normalized)) {
    return normalized
  }
  if (/^https:\/\/[^/\s]+$/u.test(normalized)) {
    return normalized
  }
  Logger.error(
    `${PROVIDER_API_BASE_URL_ENV} is not an explicit verified HTTPS host; ignoring "${configured}"`
  )
  return GITHUB_API_BASE_URL
}
