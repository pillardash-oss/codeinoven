import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubProvider } from './github-provider'
import type { PrMergeMethod } from '../../lib/types'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function captureRequest(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0]
  return { url: call[0] as string, init: (call[1] ?? {}) as RequestInit }
}

describe('GitHubProvider', () => {
  afterEach(() => {
    fetchMock.mockReset()
    delete process.env['CODEINOVEN_GIT_PROVIDER_API_BASE_URL']
  })

  it('creates a pull request with Bearer auth and the expected payload', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        number: 12,
        title: 'Add feature',
        html_url: 'https://github.com/acme/app/pull/12'
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const reference = await provider.createPullRequest({
      owner: 'acme',
      repo: 'app',
      title: 'Add feature',
      body: 'Implements the thing',
      head: 'feature/x',
      base: 'main'
    })

    const { url, init } = captureRequest()
    expect(url).toBe('https://api.github.com/repos/acme/app/pulls')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer ghp_secret_token')
    expect(JSON.parse(String(init.body))).toMatchObject({
      title: 'Add feature',
      body: 'Implements the thing',
      head: 'feature/x',
      base: 'main'
    })
    expect(reference).toEqual({
      number: 12,
      title: 'Add feature',
      url: 'https://github.com/acme/app/pull/12'
    })
  })

  it('maps every merge method to the merge_method payload', async () => {
    for (const method of ['merge', 'squash', 'rebase'] as PrMergeMethod[]) {
      fetchMock.mockReset()
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ merged: true, message: 'Pull request merged' })
      )
      const provider = new GitHubProvider('ghp_secret_token')

      await provider.mergePullRequest({ owner: 'acme', repo: 'app', pullNumber: 7, method })

      const { url, init } = captureRequest()
      expect(url).toBe('https://api.github.com/repos/acme/app/pulls/7/merge')
      expect(init.method).toBe('PUT')
      expect(JSON.parse(String(init.body))).toEqual({ merge_method: method })
    }
  })

  it('refreshes once after a 401 and still surfaces errors without leaking credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, 401))
    const provider = new GitHubProvider('ghp_never_leak_this')

    await expect(
      provider.mergePullRequest({ owner: 'acme', repo: 'app', pullNumber: 1, method: 'squash' })
    ).rejects.toThrow('Provider returned HTTP 401: Bad credentials')

    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Bad credentials' }, 401))
    fetchMock.mockResolvedValueOnce(jsonResponse({ merged: true, message: 'Pull request merged' }))
    const refreshAccessToken = vi.fn().mockResolvedValue('ghu_refreshed')
    const refreshableProvider = new GitHubProvider('ghu_expired', undefined, refreshAccessToken)

    await expect(
      refreshableProvider.mergePullRequest({
        owner: 'acme',
        repo: 'app',
        pullNumber: 2,
        method: 'squash'
      })
    ).resolves.toMatchObject({ number: 2 })
    expect(refreshAccessToken).toHaveBeenCalledOnce()
    const retryHeaders = fetchMock.mock.calls[2]?.[1]?.headers as Record<string, string>
    expect(retryHeaders['Authorization']).toBe('Bearer ghu_refreshed')
  })

  it('maps pull requests, workflow runs, and deployments into provider models', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Not Found' }, 404))
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { number: 3, title: 'First', html_url: 'https://github.com/acme/app/pull/3' },
        { number: 4, title: 'Second', html_url: 'https://github.com/acme/app/pull/4' }
      ])
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const references = await provider.listPullRequests({
      owner: 'acme',
      repo: 'app',
      state: 'open'
    })
    expect(references).toHaveLength(2)
    expect(references[0]?.number).toBe(3)
    const anonymousRetryHeaders = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>
    expect(anonymousRetryHeaders['Authorization']).toBeUndefined()

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        workflow_runs: [
          {
            id: 91,
            name: 'Release',
            display_title: 'Publish desktop build',
            run_number: 14,
            event: 'push',
            status: 'completed',
            conclusion: 'success',
            head_branch: 'main',
            head_sha: 'abcdef123456',
            html_url: 'https://github.com/acme/app/actions/runs/91',
            actor: { login: 'octocat' },
            created_at: '2026-08-08T10:00:00Z',
            updated_at: '2026-08-08T10:05:00Z'
          }
        ]
      })
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 42,
          environment: 'production',
          description: 'Desktop release',
          ref: 'main',
          sha: 'abcdef123456',
          created_at: '2026-08-08T10:01:00Z',
          updated_at: '2026-08-08T10:06:00Z'
        }
      ])
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          state: 'success',
          description: 'Deployment completed',
          environment_url: 'https://app.example.com',
          log_url: 'https://github.com/acme/app/actions/runs/91',
          created_at: '2026-08-08T10:06:00Z'
        }
      ])
    )

    const overview = await provider.getDeploymentOverview({ owner: 'acme', repo: 'app' })

    expect(overview.workflowRuns[0]).toMatchObject({
      id: 91,
      displayTitle: 'Publish desktop build',
      conclusion: 'success'
    })
    expect(overview.deployments[0]).toMatchObject({
      id: 42,
      environment: 'production',
      latestStatus: { state: 'success', environmentUrl: 'https://app.example.com' }
    })
  })

  it('resolves repository identity from HTTPS, SSH, and scp-like remote URLs', () => {
    const provider = new GitHubProvider('ghp_secret_token')
    expect(provider.resolveRepositoryIdentity('https://github.com/acme/app.git')?.owner).toBe(
      'acme'
    )
    expect(provider.resolveRepositoryIdentity('https://github.com/acme/app.git')?.repo).toBe('app')
    expect(provider.resolveRepositoryIdentity('git@github.com:acme/app.git')).toMatchObject({
      owner: 'acme',
      repo: 'app'
    })
    expect(provider.resolveRepositoryIdentity('ssh://git@github.com/acme/app.git')).toMatchObject({
      owner: 'acme',
      repo: 'app'
    })
    expect(provider.resolveRepositoryIdentity('https://example.com/other.git')).toBeNull()
    expect(provider.resolveRepositoryIdentity('')).toBeNull()
  })

  it('honors a configured localhost base URL for dev/test mocks', async () => {
    process.env['CODEINOVEN_GIT_PROVIDER_API_BASE_URL'] = 'http://localhost:9999'
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ number: 1, title: 'T', html_url: 'http://localhost:9999/repos/a/b/pull/1' })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    await provider.createPullRequest({ owner: 'a', repo: 'b', title: 'T', head: 'x', base: 'main' })
    const { url } = captureRequest()
    expect(url).toBe('http://localhost:9999/repos/a/b/pulls')
  })
})
