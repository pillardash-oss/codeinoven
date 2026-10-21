import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => resolve('.cio/tmp/assistant-setup-verification') },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => Buffer.from(`encrypted:${value}`),
    decryptStringAsync: async (value: Buffer) => ({
      result: value.toString().replace(/^encrypted:/, ''),
      shouldReEncrypt: false
    })
  }
}))

import { StorageEngine } from '../../../src/main/storage/storage-engine'
import {
  UtilityOrchestrationService,
  type UtilityTurnGateway,
  type UtilityTurnRequest
} from '../../../src/main/utilities/utility-orchestration-service'
import { UtilityRegistryService } from '../../../src/main/utilities/utility-registry-service'
import {
  ASSISTANT_AUTHORING_UTILITY_ID,
  type AssistantReportingPatch
} from '../../../src/lib/assistant-authoring'
import {
  GATEWAY_TOOLS,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  ASK_SECRET_TOOL_NAME
} from '../../../src/lib/gateway-tools'

import { AgentSecretService } from '../../../src/main/utilities/agent-secret-service'
import { SecretVault } from '../../../src/main/storage/secret-vault'
import { RemoteMcpClient } from '../../../src/main/utilities/utility-orchestration/remote-mcp-client'

let storage: StorageEngine
let service: UtilityOrchestrationService
let root: string

beforeEach(async () => {
  await mkdir(resolve('.cio/tmp/assistant-setup-verification'), { recursive: true })
  root = await mkdtemp(resolve('.cio/tmp/assistant-setup-verification/gateway-'))
  storage = new StorageEngine(root)
  await storage.initialize()
  vi.spyOn(UtilityRegistryService.prototype, 'resolve').mockResolvedValue([])
  service = new UtilityOrchestrationService(storage)
})

afterEach(async () => {
  await service?.dispose()
  vi.restoreAllMocks()
  if (root) await rm(root, { recursive: true, force: true })
})

function request(overrides: Partial<UtilityTurnRequest> = {}): UtilityTurnRequest {
  return {
    harnessId: 'codex',
    projectId: 'project-probe',
    threadId: 'thread-probe',
    projectPath: root,
    sessionId: 'session-probe',
    nativeCapabilities: ['computer_use'],
    permissionLevel: 'auto_review',
    allowManagement: true,
    budgetContext: {
      selectedModelInputTokens: 16000,
      composedTurnTokens: 1000,
      parentTurnId: 'parent'
    },
    attributeReinjectedResult: () => undefined,
    saveAssistantCheckpoint: async () => ({ path: join(root, 'checkpoint.md') }),
    ...overrides
  }
}

async function call(
  gateway: UtilityTurnGateway,
  name: string,
  input: Record<string, unknown>
): Promise<{ status: number; body: unknown }> {
  const endpoint = gateway.directEndpoint
  const route = GATEWAY_TOOLS.find((tool) => tool.name === name)?.route
  if (!endpoint || !route) throw new Error('Missing gateway endpoint or route')
  const response = await fetch(endpoint.url + route, {
    method: 'POST',
    headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input)
  })
  const result: unknown = await response.json()
  const body =
    typeof result === 'object' && result !== null && 'structuredContent' in result
      ? result.structuredContent
      : result
  return { status: response.status, body }
}
async function activate(gateway: UtilityTurnGateway): Promise<void> {
  const result = await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, {
    utility_id: ASSISTANT_AUTHORING_UTILITY_ID
  })
  expect(result.status).toBe(200)
  expect(result.body).toMatchObject({
    capability: {
      tools: expect.arrayContaining([expect.objectContaining({ name: 'save_reporting' })])
    }
  })
}
const save = (gateway: UtilityTurnGateway, input: Record<string, unknown>) =>
  call(gateway, UTILITY_INVOKE_TOOL_NAME, {
    utility_id: ASSISTANT_AUTHORING_UTILITY_ID,
    operation: 'save_reporting',
    input
  })

describe('assistant reporting through the real utility gateway', () => {
  it('saves delivery then priority without clearing the earlier answer', async () => {
    const saved: AssistantReportingPatch = {}
    const persist = vi.fn(async (patch: AssistantReportingPatch) => {
      Object.assign(saved, patch)
    })
    const gateway = await service.startTurn(request({ saveAssistantReporting: persist }))
    await activate(gateway)
    expect(await save(gateway, { delivery: { channel: 'in-app' } })).toMatchObject({
      status: 200,
      body: { status: 'saved', delivery: { channel: 'in-app' } }
    })
    expect(
      await save(gateway, { priority: { timeliness: 'today', impact: 'company' } })
    ).toMatchObject({ status: 200, body: { status: 'saved' } })
    expect(saved).toEqual({
      delivery: { channel: 'in-app' },
      priority: { timeliness: 'today', impact: 'company' }
    })
    expect(persist).toHaveBeenCalledTimes(2)
  })

  it.each([
    {},
    { delivery: null },
    { delivery: { channel: 'unknown' } },
    { priority: { timeliness: 'today' } },
    { delivery: { channel: 'in-app' }, priority: { timeliness: 'unknown', impact: 'company' } }
  ])('rejects invalid input atomically: %j', async (input) => {
    const persist = vi.fn(async () => undefined)
    const gateway = await service.startTurn(request({ saveAssistantReporting: persist }))
    await activate(gateway)
    expect((await save(gateway, input)).status).toBe(400)
    expect(persist).not.toHaveBeenCalled()
  })

  it('propagates persistence failure instead of claiming saved', async () => {
    const gateway = await service.startTurn(
      request({
        saveAssistantReporting: async () => {
          throw new Error('Database unavailable')
        }
      })
    )
    await activate(gateway)
    expect(await save(gateway, { delivery: { channel: 'in-app' } })).toEqual({
      status: 400,
      body: { error: 'Database unavailable' }
    })
  })

  it('isolates callbacks per interview and refuses a retired turn', async () => {
    const firstSave = vi.fn(async () => undefined)
    const secondSave = vi.fn(async () => undefined)
    const first = await service.startTurn(request({ saveAssistantReporting: firstSave }))
    const second = await service.startTurn(
      request({ threadId: 'other-thread', saveAssistantReporting: secondSave })
    )
    await activate(first)
    await activate(second)
    await save(second, { delivery: { channel: 'email', target: 'reports@example.com' } })
    expect(firstSave).not.toHaveBeenCalled()
    expect(secondSave).toHaveBeenCalledOnce()
    await first.cleanup()
    expect((await save(first, { delivery: { channel: 'in-app' } })).status).toBe(404)
  })

  it('does not expose the authoring capability to an ordinary turn', async () => {
    const gateway = await service.startTurn(
      request({ saveAssistantCheckpoint: undefined, saveAssistantReporting: undefined })
    )
    const result = await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, {
      utility_id: ASSISTANT_AUTHORING_UTILITY_ID
    })
    expect(result.status).toBe(400)
  })
})

describe('credentials collected during assistant setup', () => {
  it('reconnects active turns with the newly bound credential and never returns its value', async () => {
    const registry = new UtilityRegistryService(storage)
    const vault = new SecretVault(storage)
    const secrets = new AgentSecretService(vault, registry, storage)
    const utility = await registry.create({
      kind: 'mcp',
      name: 'Fixture service',
      description: 'Test fixture',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'global' },
      config: { transport: 'http', url: 'https://fixture.invalid/mcp' },
      credentials: [],
      harnessBindings: [{ harnessId: '*', strategy: 'mcp' }]
    })
    const entry = {
      secretId: 'fixture-secret',
      environmentVariable: 'FIXTURE_TOKEN',
      label: 'Fixture token',
      utilityId: utility.id,
      threadId: 'thread-probe'
    }
    await secrets.store({ ...entry, value: 'fixture-old-value' })
    vi.mocked(UtilityRegistryService.prototype.resolve).mockImplementation(async () => {
      const current = await registry.get(utility.id)
      if (!current) throw new Error('Fixture utility disappeared')
      return [{ utility: current, binding: { harnessId: 'codex', strategy: 'mcp' } }]
    })
    const close = vi.fn(async () => undefined)
    const connect = vi.spyOn(RemoteMcpClient, 'connect').mockImplementation(
      async () =>
        ({
          usable: true,
          serverInfo: {},
          close,
          listTools: async () => [{ name: 'read_profile', inputSchema: { type: 'object' } }],
          callTool: async () => ({
            content: [{ type: 'text', text: 'Authenticated fixture profile' }]
          })
        }) as unknown as RemoteMcpClient
    )
    service.setSecretRequestExecutor(async () => ({
      status: 'set',
      secrets: [await secrets.store({ ...entry, value: 'fixture-new-value' })]
    }))
    const first = await service.startTurn(request())
    const second = await service.startTurn(request({ threadId: 'second-thread' }))
    for (const gateway of [first, second]) {
      expect(
        (await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, { utility_id: utility.id })).status
      ).toBe(200)
    }
    expect(connect.mock.calls[0]?.[1]).toMatchObject({ Authorization: 'Bearer fixture-old-value' })
    const collected = await call(first, ASK_SECRET_TOOL_NAME, {
      secrets: [
        { title: 'Fixture token', utility_id: utility.id, environment_variable: 'FIXTURE_TOKEN' }
      ]
    })
    expect(collected.status).toBe(200)
    expect(JSON.stringify(collected.body)).not.toContain('fixture-new-value')
    expect(JSON.stringify(collected.body)).not.toContain('fixture-old-value')
    expect(close).toHaveBeenCalledTimes(2)
    for (const gateway of [first, second]) {
      expect(
        (
          await call(gateway, UTILITY_INVOKE_TOOL_NAME, {
            utility_id: utility.id,
            operation: 'read_profile',
            input: {}
          })
        ).status
      ).toBe(200)
    }
    expect(connect.mock.calls.slice(2).map((args) => args[1])).toEqual([
      expect.objectContaining({ Authorization: 'Bearer fixture-new-value' }),
      expect.objectContaining({ Authorization: 'Bearer fixture-new-value' })
    ])
    // A fresh service after a restart resolves the same vault-backed credential.
    const restartedRegistry = new UtilityRegistryService(new StorageEngine(root))
    const persisted = await restartedRegistry.get(utility.id)
    expect(persisted?.credentials).toHaveLength(1)
    expect(
      await new SecretVault(new StorageEngine(root)).resolve(persisted!.credentials[0]!.secretRef)
    ).toBe('fixture-new-value')
  })
})

describe('connection verification failures', () => {
  it.each([
    { statusCode: 401, message: 'Invalid access token' },
    { statusCode: 402, message: 'Credits depleted' }
  ])('preserves an authenticated read failure after activation: $statusCode', async (failure) => {
    const registry = new UtilityRegistryService(storage)
    const utility = await registry.create({
      kind: 'mcp',
      name: 'Fixture service',
      description: 'Test fixture',
      enabled: true,
      activation: 'on_demand',
      scope: { level: 'global' },
      config: { transport: 'http', url: 'https://fixture.invalid/mcp' },
      credentials: [],
      harnessBindings: [{ harnessId: '*', strategy: 'mcp' }]
    })
    vi.mocked(UtilityRegistryService.prototype.resolve).mockResolvedValue([
      { utility, binding: { harnessId: 'codex', strategy: 'mcp' } }
    ])
    vi.spyOn(RemoteMcpClient, 'connect').mockResolvedValue({
      usable: true,
      serverInfo: {},
      close: async () => undefined,
      listTools: async () => [{ name: 'read_profile', inputSchema: { type: 'object' } }],
      callTool: async () => ({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(failure) }]
      })
    } as unknown as RemoteMcpClient)
    const gateway = await service.startTurn(request())
    expect(
      (await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, { utility_id: utility.id })).status
    ).toBe(200)
    const result = await call(gateway, UTILITY_INVOKE_TOOL_NAME, {
      utility_id: utility.id,
      operation: 'read_profile',
      input: {}
    })
    expect(result.body).toMatchObject({ isError: true })
    expect(JSON.stringify(result.body)).toContain(failure.message)
  })
})
