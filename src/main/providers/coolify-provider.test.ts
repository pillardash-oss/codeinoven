import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CoolifyProvider, CoolifyProviderError } from './coolify-provider'
import type { DeploymentProviderContext } from '../deployment-provider.interface'

const fetchMock = vi.hoisted(() => vi.fn())

vi.stubGlobal('fetch', fetchMock)

const BASE_URL = 'https://coolify.example.com'
const TOKEN = 'coolify-secret-token'

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function makeProvider(context: DeploymentProviderContext = {}): CoolifyProvider {
  return new CoolifyProvider({
    baseUrl: BASE_URL,
    token: TOKEN,
    ...context
  })
}

function requestUrl(): string {
  const call = fetchMock.mock.calls[0]
  return call[0] as string
}

function requestInit(): RequestInit {
  const call = fetchMock.mock.calls[0]
  return (call[1] ?? {}) as RequestInit
}

describe('CoolifyProvider', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  afterEach(() => {
    delete process.env['CODEINOVEN_COOLIFY_BASE_URL']
  })

  describe('listContainers', () => {
    it('parses application payloads into the normalized container model', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse([
            {
              uuid: 'app-1',
              name: 'My App',
              project_name: 'Marketing',
              status: 'running',
              fqdn: 'https://app.example.dev',
              created_at: '2024-01-01T00:00:00.000Z',
              updated_at: '2024-01-02T00:00:00.000Z'
            }
          ])
        )
        .mockResolvedValueOnce(jsonResponse([]))

      const provider = makeProvider()
      const containers = await provider.listContainers()

      expect(requestUrl()).toBe(`${BASE_URL}/api/v1/applications`)
      expect(requestInit().headers).toMatchObject({
        Accept: 'application/json',
        Authorization: `Bearer ${TOKEN}`
      })
      expect(containers).toEqual([
        {
          id: 'app-1',
          label: 'My App',
          providerKind: 'coolify',
          status: 'success',
          url: 'https://app.example.dev',
          project: 'Marketing',
          createdAt: Date.parse('2024-01-01T00:00:00.000Z'),
          updatedAt: Date.parse('2024-01-02T00:00:00.000Z')
        }
      ])
    })

    it('resolves the project name from the projects endpoint when the app only carries a project_uuid', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse([
            { uuid: 'app-1', name: 'marketing website', project_uuid: 'proj-1', status: 'running' }
          ])
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { uuid: 'proj-1', name: 'Milogs' },
            { uuid: 'proj-2', name: 'Other' }
          ])
        )

      const containers = await makeProvider().listContainers()

      expect(containers[0]).toMatchObject({ id: 'app-1', project: 'Milogs' })
    })

    it('resolves the project name via environment_id when the app only carries an environment id', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse([
            { uuid: 'app-1', name: 'CodeInOven Mobile', environment_id: 7, status: 'running' },
            { uuid: 'app-2', name: 'Admin Dashboard', environment_id: 8, status: 'running' }
          ])
        )
        .mockResolvedValueOnce(
          jsonResponse([
            { id: 1, uuid: 'proj-milogs', name: 'Milogs' },
            { id: 2, uuid: 'proj-other', name: 'Marketing' }
          ])
        )
        .mockResolvedValueOnce(jsonResponse([{ id: 7, name: 'production', project_id: 1 }]))
        .mockResolvedValueOnce(jsonResponse([{ id: 8, name: 'production', project_id: 2 }]))

      const containers = await makeProvider().listContainers()

      expect(containers[0]).toMatchObject({ id: 'app-1', project: 'Milogs' })
      expect(containers[1]).toMatchObject({ id: 'app-2', project: 'Marketing' })
    })

    it('skips records without a uuid instead of failing the list', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { name: 'no-id', status: 'running' },
          { uuid: 'app-2', name: 'Valid App', status: 'healthy' }
        ])
      )

      const containers = await makeProvider().listContainers()

      expect(containers).toHaveLength(1)
      expect(containers[0]).toMatchObject({ id: 'app-2', status: 'success' })
    })

    it('falls back to fqdn then uuid for the label when name is absent', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([
          { uuid: 'app-3', status: 'running', fqdn: 'https://named.example.dev' },
          { uuid: 'app-4', status: 'running' }
        ])
      )

      const containers = await makeProvider().listContainers()

      expect(containers[0]).toMatchObject({ id: 'app-3', label: 'https://named.example.dev' })
      expect(containers[1]).toMatchObject({ id: 'app-4', label: 'app-4' })
    })

    it('returns an empty list for a non-array response body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', status: 'running' }))

      const containers = await makeProvider().listContainers()

      expect(containers).toEqual([])
    })
  })

  describe('status normalization', () => {
    it.each([
      ['running', 'success'],
      ['healthy', 'success'],
      ['up', 'success'],
      ['started', 'success'],
      ['degraded', 'success'],
      ['queued', 'building'],
      ['starting', 'building'],
      ['restarting', 'building'],
      ['building', 'building'],
      ['deploying', 'building'],
      ['exited', 'failed'],
      ['stopped', 'failed'],
      ['dead', 'failed'],
      ['failed', 'failed'],
      ['error', 'failed'],
      ['unhealthy', 'failed'],
      ['oops', 'failed'],
      ['unexpected-state', 'unknown']
    ])('normalizes application status %s -> %s', async (raw, expected) => {
      fetchMock.mockResolvedValueOnce(jsonResponse([{ uuid: 'app-1', status: raw }]))

      const containers = await makeProvider().listContainers()

      expect(containers[0].status).toBe(expected)
    })

    it('normalizes deployment statuses when a deployment record overrides the status', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', name: 'My App', status: 'running' }))
        .mockResolvedValueOnce(
          jsonResponse([{ deployment_uuid: 'dep-1', status: 'finished', logs: '' }])
        )

      const container = await makeProvider().getStatus('app-1')

      expect(container?.status).toBe('success')
    })

    it('maps an in-progress deployment to building', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', name: 'My App', status: 'running' }))
        .mockResolvedValueOnce(
          jsonResponse([{ deployment_uuid: 'dep-1', status: 'in_progress', logs: '' }])
        )

      const container = await makeProvider().getStatus('app-1')

      expect(container?.status).toBe('building')
    })

    it('maps a failed deployment to failed', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', name: 'My App', status: 'running' }))
        .mockResolvedValueOnce(
          jsonResponse([{ deployment_uuid: 'dep-1', status: 'cancelled-by-user', logs: '' }])
        )

      const container = await makeProvider().getStatus('app-1')

      expect(container?.status).toBe('failed')
    })
  })

  describe('getStatus', () => {
    it('returns the application snapshot when no deployment record exists', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', name: 'My App', status: 'running' }))
        .mockResolvedValueOnce(jsonResponse([]))

      const container = await makeProvider().getStatus('app-1')

      expect(requestUrl()).toBe(`${BASE_URL}/api/v1/applications/app-1`)
      expect(container).toMatchObject({ id: 'app-1', status: 'success' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('returns null when the application is missing (404 fallback)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))

      const container = await makeProvider().getStatus('missing-app')

      expect(container).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('lets the latest deployment override status, log, and updatedAt', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            uuid: 'app-1',
            name: 'My App',
            status: 'running',
            updated_at: '2024-01-01T00:00:00.000Z'
          })
        )
        .mockResolvedValueOnce(
          jsonResponse([
            {
              deployment_uuid: 'dep-1',
              status: 'failed',
              logs: 'Build exploded',
              updated_at: '2024-01-02T00:00:00.000Z'
            }
          ])
        )

      const container = await makeProvider().getStatus('app-1')

      expect(container?.status).toBe('failed')
      expect(container?.log).toBe('Build exploded')
      expect(container?.updatedAt).toBe(Date.parse('2024-01-02T00:00:00.000Z'))
    })

    it('degrades gracefully when the deployment list endpoint is missing (404)', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', name: 'My App', status: 'running' }))
        .mockResolvedValueOnce(jsonResponse({ message: 'route missing' }, 404))

      const container = await makeProvider().getStatus('app-1')

      expect(container).toMatchObject({ id: 'app-1', status: 'success' })
    })

    it('degrades gracefully when the deployment list endpoint is unsupported (405)', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ uuid: 'app-1', name: 'My App', status: 'running' }))
        .mockResolvedValueOnce(jsonResponse({ message: 'method not allowed' }, 405))

      const container = await makeProvider().getStatus('app-1')

      expect(container).toMatchObject({ id: 'app-1', status: 'success' })
    })
  })

  describe('getLogs', () => {
    it('returns the latest deployment log when present', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ deployment_uuid: 'dep-1', status: 'finished', logs: 'deploy log line' }])
      )

      const log = await makeProvider().getLogs('app-1')

      expect(log).toBe('deploy log line')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to the runtime logs endpoint when no deployment log exists', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ logs: 'runtime container output' }))

      const log = await makeProvider().getLogs('app-1')

      expect(fetchMock.mock.calls[1][0]).toBe(
        `${BASE_URL}/api/v1/applications/app-1/logs?lines=200`
      )
      expect(log).toBe('runtime container output')
    })

    it('returns an empty string when the fallback log body has no logs field', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse([]))
        .mockResolvedValueOnce(jsonResponse({ unrelated: true }))

      const log = await makeProvider().getLogs('app-1')

      expect(log).toBe('')
    })

    it('caps an oversized deployment log at the byte cap', async () => {
      const oversized = 'x'.repeat(250_000)
      fetchMock.mockResolvedValueOnce(
        jsonResponse([{ deployment_uuid: 'dep-1', status: 'finished', logs: oversized }])
      )

      const log = await makeProvider().getLogs('app-1')

      expect(log).toHaveLength(200_000)
    })

    it('caps an oversized runtime log at the byte cap', async () => {
      const oversized = 'x'.repeat(250_000)
      fetchMock.mockResolvedValueOnce(jsonResponse([]))
      fetchMock.mockResolvedValueOnce(jsonResponse({ logs: oversized }))

      const log = await makeProvider().getLogs('app-1')

      expect(log).toHaveLength(200_000)
    })
  })

  describe('listDeployments', () => {
    it('returns the most recent deployments newest first, bounded to the window', async () => {
      const records = Array.from({ length: 15 }, (_, index) => ({
        deployment_uuid: `dep-${index}`,
        status: index % 2 === 0 ? 'finished' : 'failed',
        updated_at: `2024-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        commit: `abc${index}`
      }))
      fetchMock.mockResolvedValueOnce(jsonResponse(records))

      const deployments = await makeProvider().listDeployments('app-1')

      expect(deployments.length).toBeLessThanOrEqual(10)
      expect(deployments[0]).toMatchObject({ id: 'dep-0', status: 'success', commit: 'abc0' })
      expect(deployments[1]).toMatchObject({ id: 'dep-1', status: 'failed' })
    })

    it('returns an empty list when the deployment endpoint is missing (404)', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))

      const deployments = await makeProvider().listDeployments('app-1')

      expect(deployments).toEqual([])
    })

    it('parses a realistic ApplicationDeploymentQueue payload, including a data wrapper', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 12,
              application_id: 'app-1',
              deployment_uuid: 'dep-abc-1',
              commit: 'a1b2c3d4e5f6',
              status: 'finished',
              created_at: '2024-01-02T10:00:00.000Z',
              updated_at: '2024-01-02T10:05:00.000Z',
              logs: 'build ok',
              commit_message: 'fix: ship it'
            },
            {
              id: 11,
              application_id: 'app-1',
              deployment_uuid: 'dep-abc-2',
              commit: 'f6e5d4c3b2a1',
              status: 'failed',
              created_at: '2024-01-01T09:00:00.000Z',
              updated_at: '2024-01-01T09:10:00.000Z',
              logs: 'build exploded'
            }
          ]
        })
      )

      const deployments = await makeProvider().listDeployments('app-1')

      expect(deployments).toHaveLength(2)
      expect(deployments[0]).toMatchObject({
        id: 'dep-abc-1',
        status: 'success',
        commit: 'a1b2c3d4e5f6',
        updatedAt: Date.parse('2024-01-02T10:05:00.000Z')
      })
      expect(deployments[1]).toMatchObject({ id: 'dep-abc-2', status: 'failed' })
      expect(requestUrl()).toContain('/deployments/applications/app-1')
    })
  })

  describe('errors', () => {
    it('throws a typed provider error carrying the HTTP status', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, 401))

      await expect(makeProvider().listContainers()).rejects.toMatchObject({
        name: 'CoolifyProviderError',
        status: 401,
        message: 'unauthorized'
      })
    })

    it('reads the provider error field when message is absent', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'server error' }, 500))

      await expect(makeProvider().listContainers()).rejects.toMatchObject({
        status: 500,
        message: 'server error'
      })
    })

    it('throws when no token is configured', async () => {
      const provider = makeProvider({ token: undefined })

      await expect(provider.listContainers()).rejects.toBeInstanceOf(CoolifyProviderError)
      await expect(provider.listContainers()).rejects.toThrow('token is not configured')
    })

    it('throws when no base URL is configured and none is set via env', async () => {
      const provider = makeProvider({ baseUrl: undefined })

      await expect(provider.listContainers()).rejects.toBeInstanceOf(CoolifyProviderError)
      await expect(provider.listContainers()).rejects.toThrow('base URL is not configured')
    })
  })

  describe('timeout', () => {
    it('rejects with a timeout message when the request aborts', async () => {
      vi.useFakeTimers()
      try {
        fetchMock.mockImplementation(
          (_url: string | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () =>
                reject(new DOMException('The operation was aborted.', 'AbortError'))
              )
            })
        )

        const provider = makeProvider()
        const pending = provider.listContainers()

        const assertion = expect(pending).rejects.toThrow('Coolify request timed out')
        await vi.advanceTimersByTimeAsync(15_001)
        await assertion
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('getProviderInfo', () => {
    it('exposes kind, name, implemented, and the configured base URL', () => {
      const info = makeProvider().getProviderInfo()

      expect(info).toEqual({
        kind: 'coolify',
        name: 'Coolify',
        implemented: true,
        baseUrl: BASE_URL
      })
    })

    it('omits baseUrl when none is configured', () => {
      const info = makeProvider({ baseUrl: undefined }).getProviderInfo()

      expect(info).toEqual({ kind: 'coolify', name: 'Coolify', implemented: true })
    })
  })
})
