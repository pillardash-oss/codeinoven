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

  it('lists a page of issues through one GraphQL search, reading the comment count from the issue connection', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          search: {
            pageInfo: { hasNextPage: true, endCursor: 'ISSUE_CURSOR_1' },
            nodes: [
              {
                __typename: 'Issue',
                number: 7,
                title: 'Fix the flaky test',
                url: 'https://github.com/acme/app/issues/7',
                state: 'CLOSED',
                stateReason: 'NOT_PLANNED',
                createdAt: '2026-08-01T10:00:00Z',
                updatedAt: '2026-08-02T11:00:00Z',
                author: { login: 'octocat', avatarUrl: 'https://avatars.example/octocat.png' },
                labels: {
                  nodes: [{ name: 'bug', color: 'ff0000' }, { color: '00ff00' }]
                },
                assignees: {
                  nodes: [
                    {
                      login: 'hubot',
                      name: 'Hubot',
                      avatarUrl: 'https://avatars.example/hubot.png'
                    }
                  ]
                },
                milestone: {
                  number: 3,
                  title: 'v1.0',
                  state: 'OPEN',
                  description: 'First release',
                  dueOn: '2026-09-01T00:00:00Z'
                },
                comments: { totalCount: 4 }
              },
              { __typename: 'PullRequest', number: 8, title: 'A pull request' },
              { __typename: 'Issue', number: 0, title: 'No usable number' }
            ]
          }
        }
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const page = await provider.listIssuePage({
      owner: 'acme',
      repo: 'app',
      state: 'open',
      filter: 'created',
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
    expect(body.query).toContain('query IssueList')
    // An issue's comment count is the `comments` connection, not the pull
    // request's `totalCommentsCount` scalar, which the Issue type does not
    // declare. Asking for it fails the whole search with a GraphQL error.
    expect(body.query).not.toContain('totalCommentsCount')
    expect(body.query).toContain('totalCount')
    expect(body.variables['q']).toBe('is:issue repo:acme/app is:open author:@me sort:updated-desc')
    expect(body.variables['first']).toBe(20)
    expect(body.variables['after']).toBeNull()

    // The pull request node and the numberless issue are both dropped.
    expect(page.items.map((item) => item.number)).toEqual([7])
    expect(page.page).toBe(1)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('ISSUE_CURSOR_1')
    expect(page.items[0]).toMatchObject({
      number: 7,
      title: 'Fix the flaky test',
      url: 'https://github.com/acme/app/issues/7',
      state: 'closed',
      stateReason: 'not_planned',
      authorLogin: 'octocat',
      authorAvatarUrl: 'https://avatars.example/octocat.png',
      authorIsBot: false,
      comments: 4,
      labels: [{ name: 'bug', color: 'ff0000' }],
      assignees: [
        {
          login: 'hubot',
          name: 'Hubot',
          avatarUrl: 'https://avatars.example/hubot.png',
          bot: false
        }
      ],
      milestone: {
        number: 3,
        title: 'v1.0',
        state: 'open',
        description: 'First release',
        dueOn: '2026-09-01T00:00:00Z'
      }
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

  it('reads reactions for an issue and its comments through one batched nodes(ids:) query', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          nodes: [
            {
              id: 'I_issue',
              reactionGroups: [
                {
                  content: 'THUMBS_UP',
                  viewerHasReacted: true,
                  reactors: {
                    totalCount: 2,
                    nodes: [
                      {
                        __typename: 'User',
                        login: 'octocat',
                        avatarUrl: 'https://avatars.example/octocat.png'
                      },
                      { __typename: 'Bot', login: 'dependabot[bot]', avatarUrl: null }
                    ]
                  }
                },
                // A group with no reactors is not a reaction, and must not become one.
                {
                  content: 'HEART',
                  viewerHasReacted: false,
                  reactors: { totalCount: 0, nodes: [] }
                }
              ]
            },
            // An issue comment nobody has reacted to answers with no groups, and the
            // subject the read could not resolve answers as null.
            { id: 'IC_comment', reactionGroups: [] },
            null
          ]
        }
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const reactions = await provider.listReactions(['I_issue', 'IC_comment', 'I_missing'])

    const { url, init } = captureRequest()
    expect(url).toBe('https://api.github.com/graphql')
    const body = JSON.parse(String(init.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    expect(body.query).toContain('nodes(ids: $ids)')
    expect(body.query).toContain('... on Reactable')
    expect(body.variables['ids']).toEqual(['I_issue', 'IC_comment', 'I_missing'])

    // Only the subject that actually carries a reaction is in the map.
    expect(Object.keys(reactions)).toEqual(['I_issue'])
    expect(reactions['I_issue']).toEqual([
      {
        content: 'THUMBS_UP',
        viewerHasReacted: true,
        count: 2,
        actors: [
          { login: 'octocat', avatarUrl: 'https://avatars.example/octocat.png' },
          { login: 'dependabot[bot]', avatarUrl: null }
        ]
      }
    ])
  })

  it('adds a reaction on one subject and reads the groups back from the answer', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          addReaction: {
            subject: {
              reactionGroups: [
                {
                  content: 'ROCKET',
                  viewerHasReacted: true,
                  reactors: {
                    totalCount: 1,
                    nodes: [{ __typename: 'User', login: 'octocat', avatarUrl: null }]
                  }
                }
              ]
            }
          }
        }
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const groups = await provider.setReaction({ nodeId: 'I_issue', content: 'ROCKET', add: true })

    const { url, init } = captureRequest()
    expect(url).toBe('https://api.github.com/graphql')
    const body = JSON.parse(String(init.body)) as {
      query: string
      variables: Record<string, unknown>
    }
    expect(body.query).toContain('mutation SetReaction')
    expect(body.query).toContain('addReaction(input: { subjectId: $subjectId, content: $content })')
    expect(body.variables).toEqual({ subjectId: 'I_issue', content: 'ROCKET' })
    expect(groups).toEqual([
      {
        content: 'ROCKET',
        viewerHasReacted: true,
        count: 1,
        actors: [{ login: 'octocat', avatarUrl: null }]
      }
    ])
  })

  it('takes a reaction back through removeReaction', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ data: { removeReaction: { subject: { reactionGroups: [] } } } })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const groups = await provider.setReaction({ nodeId: 'I_issue', content: 'ROCKET', add: false })

    const { init } = captureRequest()
    const body = JSON.parse(String(init.body)) as { query: string }
    expect(body.query).toContain('removeReaction(input:')
    expect(groups).toEqual([])
  })

  /**
   * The timeline mapper, against payloads captured from GitHub itself.
   *
   * Every shape below was read from a live response rather than written from
   * memory, because a guessed key is exactly what fails silently: the row would
   * simply never appear, or appear saying nothing.
   */
  it('maps an issue timeline, keeping the rendered events and dropping the noise', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 32958988993,
          event: 'labeled',
          actor: { login: 'mrprotocoll', avatar_url: 'https://x/l.png', type: 'User' },
          label: { name: 'bug', color: 'D73A4A' },
          created_at: '2026-10-10T09:24:21Z'
        },
        {
          id: 1,
          event: 'assigned',
          actor: { login: 'pillardash', type: 'User' },
          assignee: { login: 'leonardosahon' },
          created_at: '2026-10-10T21:24:52Z'
        },
        {
          id: 2,
          event: 'closed',
          actor: { login: 'leonardosahon', type: 'User' },
          state_reason: 'not_planned',
          created_at: '2026-10-10T21:29:28Z'
        },
        {
          id: 3,
          event: 'renamed',
          actor: { login: 'brunobarrientos', type: 'User' },
          rename: { from: 'old title', to: 'new title' },
          created_at: '2026-10-09T07:45:07Z'
        },
        {
          id: 4,
          event: 'referenced',
          actor: { login: 'goodtune', type: 'User' },
          commit_id: 'bb8967ed597dd166492418eb12c22c28e4e7be65',
          created_at: '2026-09-19T02:59:11Z'
        },
        {
          id: 5,
          event: 'cross-referenced',
          actor: { login: 'drogers0', type: 'User' },
          source: {
            issue: {
              number: 56,
              title: 'Tracking: native upload',
              html_url: 'https://github.com/drogers0/gh-image/issues/56',
              repository: { full_name: 'drogers0/gh-image' }
            }
          },
          created_at: '2026-09-01T15:57:11Z'
        },
        {
          id: 6,
          event: 'cross-referenced',
          actor: { login: 'coderabbitai', type: 'Bot' },
          source: {
            issue: {
              number: 228,
              title: 'Fix the thing',
              html_url: 'https://github.com/acme/app/pull/228',
              repository: { full_name: 'acme/app' },
              pull_request: { url: 'https://api.github.com/pulls/228' }
            }
          },
          created_at: '2026-07-13T02:31:16Z'
        },
        {
          id: 7,
          event: 'marked_as_duplicate',
          actor: { login: 'williammartin', type: 'User' },
          created_at: '2026-10-08T08:20:54Z'
        },
        {
          id: 8,
          event: 'issue_field_added',
          actor: { login: 'pillardash', type: 'User' },
          created_at: '2026-10-10T21:25:01Z'
        },
        // The two the renderer must never show: notification plumbing github.com
        // itself hides, plus a comment whose row belongs to the comment list.
        {
          id: 9,
          event: 'subscribed',
          actor: { login: 'someone', type: 'User' },
          created_at: '2026-10-10T09:24:22Z'
        },
        {
          id: 10,
          event: 'mentioned',
          actor: { login: 'someone', type: 'User' },
          created_at: '2026-10-10T09:24:23Z'
        },
        {
          id: 11,
          event: 'commented',
          actor: { login: 'pullfrog[bot]', type: 'Bot' },
          created_at: '2026-10-10T09:24:24Z'
        }
      ])
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const timeline = await provider.listIssueTimeline({
      owner: 'acme',
      repo: 'app',
      issueNumber: 209
    })

    const { url } = captureRequest()
    expect(url).toBe('https://api.github.com/repos/acme/app/issues/209/timeline?per_page=100')
    expect(timeline.map((event) => event.kind)).toEqual([
      'labeled',
      'assigned',
      'closed',
      'renamed',
      'referenced',
      'cross-referenced',
      'cross-referenced',
      'marked_as_duplicate',
      'fields'
    ])
    expect(timeline[0]).toMatchObject({
      id: '32958988993',
      actorLogin: 'mrprotocoll',
      actorIsBot: false,
      label: { name: 'bug', color: 'D73A4A' }
    })
    expect(timeline[1]).toMatchObject({ actorLogin: 'pillardash', assigneeLogin: 'leonardosahon' })
    expect(timeline[2]).toMatchObject({ closeReason: 'not_planned' })
    expect(timeline[3]).toMatchObject({ rename: { from: 'old title', to: 'new title' } })
    expect(timeline[4]).toMatchObject({ commitId: 'bb8967ed597dd166492418eb12c22c28e4e7be65' })
    expect(timeline[5]).toMatchObject({
      actorIsBot: false,
      reference: {
        number: 56,
        repository: 'drogers0/gh-image',
        isPullRequest: false,
        url: 'https://github.com/drogers0/gh-image/issues/56'
      }
    })
    expect(timeline[6]).toMatchObject({
      actorIsBot: true,
      reference: { number: 228, repository: 'acme/app', isPullRequest: true }
    })
  })

  it('reads a close reason of duplicate and a bot actor from a timeline event', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 42,
          event: 'closed',
          actor: { login: 'cli-triage[bot]', type: 'Bot' },
          state_reason: 'duplicate',
          created_at: '2026-10-08T08:20:54Z'
        }
      ])
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const timeline = await provider.listIssueTimeline({
      owner: 'acme',
      repo: 'app',
      issueNumber: 1
    })

    expect(timeline).toHaveLength(1)
    expect(timeline[0]).toMatchObject({
      kind: 'closed',
      closeReason: 'duplicate',
      actorIsBot: true
    })
  })

  it('reads a duplicate close reason from an issue summary and its detail', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        number: 7,
        title: 'Projects classic',
        html_url: 'https://github.com/acme/app/issues/7',
        state: 'closed',
        state_reason: 'duplicate',
        user: { login: 'acme', type: 'User' },
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
        comments: 1
      })
    )
    const provider = new GitHubProvider('ghp_secret_token')

    const detail = await provider.getIssue({ owner: 'acme', repo: 'app', issueNumber: 7 })

    expect(detail.stateReason).toBe('duplicate')
  })
})
