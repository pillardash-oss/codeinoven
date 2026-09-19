import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubProvider, ProviderHttpError } from '../../../src/main/providers/github-provider'
import type { PrMergeMethod } from '../../../src/lib/types'

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

  it('surfaces the specific error from errors[] instead of the generic Validation Failed', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          message: 'Validation Failed',
          errors: [
            {
              resource: 'PullRequest',
              code: 'custom',
              message: 'A pull request already exists for acme:feature-x.'
            }
          ]
        },
        422
      )
    )
    const provider = new GitHubProvider('ghp_secret_token')

    await expect(
      provider.createPullRequest({
        owner: 'acme',
        repo: 'app',
        title: 'Duplicate',
        head: 'feature/x',
        base: 'main'
      })
    ).rejects.toThrow(
      'Provider returned HTTP 422: A pull request already exists for acme:feature-x.'
    )
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

  it('maps a workflow run and its jobs into the run detail model', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
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
      })
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        total_count: 1,
        jobs: [
          {
            id: 77,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-08-08T10:01:00Z',
            completed_at: '2026-08-08T10:02:00Z',
            html_url: 'https://github.com/acme/app/actions/runs/91/job/77',
            steps: [{ number: 1, name: 'Checkout', status: 'completed', conclusion: 'success' }]
          }
        ]
      })
    )

    const provider = new GitHubProvider('ghp_secret_token')
    const detail = await provider.getWorkflowRunDetail({ owner: 'acme', repo: 'app', runId: 91 })

    expect(detail.run).toMatchObject({ id: 91, displayTitle: 'Publish desktop build' })
    expect(detail.jobs).toHaveLength(1)
    expect(detail.jobs[0]).toMatchObject({ id: 77, name: 'build', conclusion: 'success' })
    expect(detail.jobs[0]?.steps[0]).toMatchObject({ name: 'Checkout', conclusion: 'success' })
  })

  it('lists a page of pull requests through one GraphQL search with labels, comments, and checks', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          search: {
            pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
            nodes: [
              {
                __typename: 'PullRequest',
                number: 42,
                title: 'Harden the parser',
                url: 'https://github.com/acme/app/pull/42',
                state: 'MERGED',
                isDraft: true,
                createdAt: '2026-08-01T10:00:00Z',
                updatedAt: '2026-08-02T11:00:00Z',
                mergeable: 'CONFLICTING',
                mergeStateStatus: 'DIRTY',
                headRefName: 'feature/parser',
                baseRefName: 'main',
                author: { login: 'octocat', avatarUrl: 'https://avatars.example/octocat.png' },
                labels: {
                  nodes: [
                    { name: 'bug', color: 'ff0000' },
                    { color: '00ff00' },
                    { name: 'urgent', color: '0000ff' }
                  ]
                },
                totalCommentsCount: 7,
                commits: {
                  nodes: [
                    {
                      commit: {
                        statusCheckRollup: {
                          state: 'FAILURE',
                          contexts: {
                            totalCount: 3,
                            nodes: [
                              {
                                __typename: 'CheckRun',
                                status: 'COMPLETED',
                                conclusion: 'FAILURE'
                              },
                              { __typename: 'StatusContext', state: 'SUCCESS' },
                              {
                                __typename: 'CheckRun',
                                status: 'IN_PROGRESS',
                                conclusion: 'SUCCESS'
                              }
                            ]
                          }
                        }
                      }
                    }
                  ]
                }
              },
              { __typename: 'Issue', number: 9, title: 'An issue' },
              { __typename: 'PullRequest', number: 43, title: 'No checks yet' }
            ]
          }
        }
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const page = await provider.listPullRequestPage({
      owner: 'acme',
      repo: 'app',
      state: 'open',
      filter: 'authored',
      sort: 'updated',
      perPage: 20,
      page: 1,
      cursor: null
    })

    const { url, init } = captureRequest()
    expect(url).toBe('https://api.github.com/graphql')
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    expect(body.query).toContain('query PullRequestList')
    expect(body.query).toContain('search(query: $q, type: ISSUE, first: $first, after: $after)')
    expect(body.query).toContain('statusCheckRollup')
    expect(body.variables['q']).toBe('is:pr repo:acme/app is:open author:@me sort:updated-desc')
    expect(body.variables['first']).toBe(20)
    expect(body.variables['after']).toBeNull()

    // The Issue node is dropped, and the last node carries no check signal at all.
    expect(page.items.map((item) => item.number)).toEqual([42, 43])
    expect(page.items[1]?.checks).toBeUndefined()

    expect(page.page).toBe(1)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('CURSOR_1')
    expect(page.items[0]).toMatchObject({
      number: 42,
      title: 'Harden the parser',
      url: 'https://github.com/acme/app/pull/42',
      state: 'merged',
      draft: true,
      authorLogin: 'octocat',
      authorAvatarUrl: 'https://avatars.example/octocat.png',
      authorIsBot: false,
      headRef: 'feature/parser',
      baseRef: 'main',
      createdAt: '2026-08-01T10:00:00Z',
      updatedAt: '2026-08-02T11:00:00Z',
      comments: 7,
      labels: [
        { name: 'bug', color: 'ff0000' },
        { name: 'urgent', color: '0000ff' }
      ],
      checks: { state: 'failure', passed: 1, total: 3 },
      mergeable: false,
      mergeableState: 'dirty'
    })
  })

  it('clamps the GraphQL page size and continues from the passed cursor', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          search: {
            pageInfo: { hasNextPage: false, endCursor: 'CURSOR_2' },
            nodes: []
          }
        }
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const page = await provider.listPullRequestPage({
      owner: 'acme',
      repo: 'app',
      state: 'all',
      filter: 'all',
      sort: 'created',
      perPage: 200,
      page: 3,
      cursor: 'CURSOR_1'
    })

    const body = JSON.parse(String(captureRequest().init.body)) as {
      variables: Record<string, unknown>
    }
    // `all` adds no state or relationship qualifier, and the page size is capped.
    expect(body.variables['q']).toBe('is:pr repo:acme/app sort:created-desc')
    expect(body.variables['first']).toBe(50)
    expect(body.variables['after']).toBe('CURSOR_1')
    expect(page.page).toBe(3)
    expect(page.hasMore).toBe(false)
    // GitHub reports the last node's cursor even on the final page, where
    // following it returns nothing. A cursor is a way into a page that exists,
    // so the last page reports none.
    expect(page.nextCursor).toBeNull()
  })

  it('maps a FORBIDDEN GraphQL error to a ProviderHttpError with status 403', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }]
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const failure = await provider
      .listPullRequestPage({
        owner: 'acme',
        repo: 'app',
        state: 'open',
        filter: 'assigned',
        sort: 'updated',
        perPage: 20,
        page: 1,
        cursor: null
      })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProviderHttpError)
    expect(failure).toMatchObject({ status: 403 })
    expect((failure as ProviderHttpError).message).toContain(
      'Resource not accessible by integration'
    )
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
