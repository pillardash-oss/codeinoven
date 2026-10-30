import type { GitRepositoryIdentity, PrCommentKind } from '../../../lib/types'
import type { IssueTarget, PullRequestTarget } from '../../git/git-provider.interface'
import {
  GITHUB_API_ACCEPT,
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  PROVIDER_FETCH_TIMEOUT_MS,
  ProviderGraphqlError,
  ProviderHttpError,
  USER_AGENT
} from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  api-core */
export class GitHubProviderApiCore {
  constructor(private readonly host: GitHubProvider) {}

  /** Read pages sequentially so long conversations do not fan out requests. */
  async readCollection(path: string): Promise<unknown[]> {
    const items: unknown[] = []
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(`${path}${page === 1 ? '' : `&page=${page}`}`, {
        method: 'GET'
      })
      if (!Array.isArray(response)) throw new Error('GitHub returned an invalid collection')
      items.push(...response)
      if (response.length < 100) return items
    }
    throw new Error('GitHub history exceeds the supported page limit')
  }

  /**
   * Where GitHub files a comment of this kind.
   *
   * Both collections are repository-scoped   the pull number appears in neither
   * path   which is why the target still carries one: it keeps every comment
   * input the same shape as the one that creates them.
   */
  commentCollectionPath(kind: PrCommentKind): string {
    return kind === 'review' ? '/pulls/comments' : '/issues/comments'
  }

  /** The numeric comment ids a GraphQL thread node holds, in thread order. */
  readDatabaseIds(thread: Record<string, unknown>): number[] {
    const comments = this.host.readRecord(thread, 'comments')
    const nodes = comments ? comments['nodes'] : null
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): number[] => {
      if (typeof node !== 'object' || node === null) return []
      const id = this.host.readNumber(node as Record<string, unknown>, 'databaseId')
      return id > 0 ? [id] : []
    })
  }

  /** Build the permalink GitHub's own site uses for a pull request conversation. */

  /** Build the permalink GitHub's own site uses for a pull request conversation. */
  pullPermalink(input: PullRequestTarget): string {
    return `https://github.com/${input.owner}/${input.repo}/pull/${String(input.pullNumber)}`
  }

  /** Map an inline diff comment. GitHub's site links these with `#discussion_r<id>`. */

  /** Download redirected raw content while using GitHub's required JSON media type. */
  async requestText(path: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS)
    const init: RequestInit = { method: 'GET' }
    try {
      let token = this.host.token
      let response = await this.fetch(path, init, token, controller.signal)
      if (response.status === 401 && this.host.refreshAccessToken) {
        const refreshedToken = await this.host.refreshAccessToken()
        if (refreshedToken && refreshedToken !== token) {
          token = refreshedToken
          response = await this.fetch(path, init, token, controller.signal)
        }
      }
      // A signed-in token can still get a 404 for a public repository it cannot
      // reach. Public GET endpoints remain readable without credentials, so
      // retry those reads anonymously. Never do this for mutations or a
      // configured self-hosted provider.
      if (
        response.status === 404 &&
        (init.method ?? 'GET').toUpperCase() === 'GET' &&
        this.host.baseUrl === GITHUB_API_BASE_URL
      ) {
        const anonymousResponse = await this.fetch(path, init, null, controller.signal)
        // Only prefer the anonymous retry when it actually succeeds or still reports
        // "not found". An anonymous 403 just means the resource requires auth (e.g. a
        // private repo's job logs)   that must not clobber the original 404, which is
        // usually the accurate "not available yet" status (e.g. logs not generated yet).
        if (anonymousResponse.ok || anonymousResponse.status === 404) {
          response = anonymousResponse
        }
      }
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new ProviderHttpError(response.status, message)
      }
      return await response.text()
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Provider request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
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

  /** Perform a JSON fetch against the provider, sanitizing errors. */
  async request(path: string, init: RequestInit): Promise<Record<string, unknown> | unknown[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS)
    try {
      let token = this.host.token
      let response = await this.fetch(path, init, token, controller.signal)
      if (response.status === 401 && this.host.refreshAccessToken) {
        const refreshedToken = await this.host.refreshAccessToken()
        if (refreshedToken && refreshedToken !== token) {
          token = refreshedToken
          response = await this.fetch(path, init, token, controller.signal)
        }
      }
      if (
        response.status === 404 &&
        (init.method ?? 'GET').toUpperCase() === 'GET' &&
        this.host.baseUrl === GITHUB_API_BASE_URL
      ) {
        const anonymousResponse = await this.fetch(path, init, null, controller.signal)
        // Only prefer the anonymous retry when it actually succeeds or still reports
        // "not found". An anonymous 403 just means the resource requires auth (e.g. a
        // private repo's job logs)   that must not clobber the original 404, which is
        // usually the accurate "not available yet" status (e.g. logs not generated yet).
        if (anonymousResponse.ok || anonymousResponse.status === 404) {
          response = anonymousResponse
        }
      }
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new ProviderHttpError(response.status, message)
      }
      if (response.status === 204) return {}
      // A re-run answers 201 with an empty body, which `json()` cannot parse; a
      // body-less success is a value-less success, not a malformed response.
      const text = await response.text()
      if (!text.trim()) return {}
      return JSON.parse(text) as Record<string, unknown> | unknown[]
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Provider request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  fetch(
    path: string,
    init: RequestInit,
    token: string | null,
    signal: AbortSignal
  ): Promise<Response> {
    return fetch(`${this.host.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: GITHUB_API_ACCEPT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers
      },
      signal
    })
  }

  /**
   * Read a provider error body's message without touching headers. GitHub wraps
   * the actionable reason in `errors[0].message` (e.g. "A pull request already
   * exists for …") while the top-level `message` stays the generic
   * "Validation Failed", so the specific reason is preferred when present.
   */

  /**
   * Read a provider error body's message without touching headers. GitHub wraps
   * the actionable reason in `errors[0].message` (e.g. "A pull request already
   * exists for …") while the top-level `message` stays the generic
   * "Validation Failed", so the specific reason is preferred when present.
   */
  async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (Array.isArray(body['errors'])) {
        for (const entry of body['errors']) {
          if (typeof entry !== 'object' || entry === null) continue
          const detail = (entry as Record<string, unknown>)['message']
          if (typeof detail === 'string' && detail.trim()) return detail.slice(0, 500)
        }
      }
      if (typeof body['message'] === 'string') return body['message'].slice(0, 500)
    } catch {
      // Non-JSON error body   fall through to the status-only message.
    }
    return ''
  }

  repoPath(input: { owner: string; repo: string }): string {
    return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  }

  /**
   * Run one GraphQL query or mutation and return its `data` record.
   *
   * Some GitHub operations exist only on GraphQL, so the transport and its error
   * unwrapping live here once rather than in each caller. The unwrapping matters:
   * GraphQL answers HTTP 200 with an `errors` array when a request is rejected,
   * so without this a failure would read as success.
   */

  /**
   * Run one GraphQL query or mutation and return its `data` record.
   *
   * Some GitHub operations exist only on GraphQL, so the transport and its error
   * unwrapping live here once rather than in each caller. The unwrapping matters:
   * GraphQL answers HTTP 200 with an `errors` array when a request is rejected,
   * so without this a failure would read as success.
   */
  async runGraphql(
    query: string,
    variables: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.request('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables })
    })
    const responseRecord = Array.isArray(response) ? {} : response
    const errors = responseRecord['errors']
    if (Array.isArray(errors)) {
      const first = errors.find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      )
      const message = first ? this.host.readString(first, 'message') : null
      const type = first ? this.host.readString(first, 'type') : null
      throw new ProviderGraphqlError(
        message?.slice(0, 500) ?? 'The provider rejected the request',
        type
      )
    }
    return this.host.readRecord(responseRecord, 'data') ?? {}
  }

  /**
   * Map one GraphQL search node to the renderer-safe summary, or null when it is
   * not a pull request (an issue search returns both kinds of node) or has no
   * usable number.
   */

  pullPath(input: PullRequestTarget): string {
    return `${this.repoPath(input)}/pulls/${input.pullNumber}`
  }

  /** Map a GitHub pull payload to the renderer-safe summary, or null if unusable. */

  /** Address one issue's REST resource. */
  issuePath(input: IssueTarget): string {
    return `${this.repoPath(input)}/issues/${input.issueNumber}`
  }

  /** Map a GitHub issue payload to the reference a create or state change returns. */
}
