import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => resolve('.cio/tmp/utility-invoke-batch') },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined },
  safeStorage: {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => 'gnome_libsecret',
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
  UTILITY_INVOKE_TOOL_NAME
} from '../../../src/lib/gateway-tools'

/**
 * The batch contract of `cio_util_use`: one call carries `inputs` and runs the
 * same operation over many items with bounded concurrency, returning one entry
 * per item in the caller's order. These tests drive the real gateway routes, so
 * they cover the shape a harness bridge actually posts, including the
 * `input: {}` default that once made every batched call fail as "both".
 */

let storage: StorageEngine
let service: UtilityOrchestrationService
let root: string

beforeEach(async () => {
  await mkdir(resolve('.cio/tmp/utility-invoke-batch'), { recursive: true })
  root = await mkdtemp(resolve('.cio/tmp/utility-invoke-batch/turn-'))
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
    saveAssistantReporting: async () => undefined,
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

async function readyGateway(): Promise<UtilityTurnGateway> {
  const gateway = await service.startTurn(request())
  const activation = await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, {
    utility_id: ASSISTANT_AUTHORING_UTILITY_ID
  })
  expect(activation.status).toBe(200)
  return gateway
}

const invoke = (
  gateway: UtilityTurnGateway,
  body: Record<string, unknown>
): Promise<{ status: number; body: unknown }> =>
  call(gateway, UTILITY_INVOKE_TOOL_NAME, {
    utility_id: ASSISTANT_AUTHORING_UTILITY_ID,
    operation: 'save_reporting',
    ...body
  })

interface BatchEntry {
  ok: boolean
  result?: unknown
  error?: string
}

function resultsOf(body: unknown): BatchEntry[] {
  const record = body as { results?: BatchEntry[] } | null
  if (!Array.isArray(record?.results)) throw new Error('The batch returned no results array')
  return record.results
}

describe('cio_util_use batch invocations', () => {
  it('runs every item in order and reports one result per item', async () => {
    const saved: AssistantReportingPatch[] = []
    const gateway = await service.startTurn(
      request({
        saveAssistantReporting: async (patch) => {
          saved.push(patch)
        }
      })
    )
    await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, { utility_id: ASSISTANT_AUTHORING_UTILITY_ID })

    const batch = await invoke(gateway, {
      inputs: [
        { delivery: { channel: 'in-app' } },
        { priority: { timeliness: 'today', impact: 'company' } }
      ]
    })

    expect(batch.status).toBe(200)
    const results = resultsOf(batch.body)
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ ok: true, result: { status: 'saved' } })
    expect(results[1]).toMatchObject({ ok: true, result: { status: 'saved' } })
    expect(saved).toEqual([
      { delivery: { channel: 'in-app' } },
      { priority: { timeliness: 'today', impact: 'company' } }
    ])
  })

  it('accepts an empty input object beside inputs, which is not a conflict', async () => {
    const gateway = await readyGateway()

    // The shape every harness bridge used to post: its serializer fills the
    // omitted object parameter with {} and sends it along with the batch.
    const batch = await invoke(gateway, {
      input: {},
      inputs: [{ delivery: { channel: 'in-app' } }]
    })

    expect(batch.status).toBe(200)
    expect(resultsOf(batch.body)).toEqual([expect.objectContaining({ ok: true })])
  })

  it('rejects a real input beside inputs', async () => {
    const gateway = await readyGateway()

    const batch = await invoke(gateway, {
      input: { delivery: { channel: 'in-app' } },
      inputs: [{ delivery: { channel: 'email', target: 'reports@example.com' } }]
    })

    expect(batch).toEqual({
      status: 400,
      body: { error: 'Pass either input or inputs, not both' }
    })
  })

  it('settles each item on its own so one failure keeps the rest', async () => {
    const persist = vi.fn(async () => undefined)
    const gateway = await service.startTurn(
      request({
        saveAssistantReporting: persist
      })
    )
    await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, { utility_id: ASSISTANT_AUTHORING_UTILITY_ID })

    const batch = await invoke(gateway, {
      inputs: [{}, { delivery: { channel: 'in-app' } }]
    })

    expect(batch.status).toBe(200)
    const results = resultsOf(batch.body)
    expect(results[0]?.ok).toBe(false)
    expect(typeof results[0]?.error).toBe('string')
    expect(results[1]).toMatchObject({ ok: true, result: { status: 'saved' } })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('refuses an empty batch', async () => {
    const gateway = await readyGateway()

    expect(await invoke(gateway, { inputs: [] })).toEqual({
      status: 400,
      body: { error: 'inputs must be a non-empty array of operation inputs' }
    })
  })
})

describe('cio_util_init batch activations', () => {
  it('accepts an empty utility_id beside inputs, which is not a conflict', async () => {
    const gateway = await service.startTurn(request())

    const batch = await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, {
      utility_id: '',
      inputs: [{ utility_id: ASSISTANT_AUTHORING_UTILITY_ID }]
    })

    expect(batch.status).toBe(200)
    const results = batch.body as { results?: BatchEntry[] }
    expect(results.results?.[0]).toMatchObject({ ok: true })
  })

  it('rejects a real utility_id beside inputs', async () => {
    const gateway = await service.startTurn(request())

    expect(
      await call(gateway, UTILITY_ACTIVATE_TOOL_NAME, {
        utility_id: ASSISTANT_AUTHORING_UTILITY_ID,
        inputs: [{ utility_id: ASSISTANT_AUTHORING_UTILITY_ID }]
      })
    ).toEqual({
      status: 400,
      body: { error: 'Pass either utility_id or inputs, not both' }
    })
  })
})
