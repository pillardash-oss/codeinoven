import { homedir } from 'node:os'
import type { OfferedProvider } from '../../lib/types'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { prepareHarnessInvocation } from '../drivers/harness-runtime'
import { PiRpcClient } from '../drivers/pi-rpc-client'

/**
 * Enumerate every provider in Pi's model catalog via a short-lived RPC
 * session — the same probe the driver uses for model discovery, grouped to one
 * entry per provider. This returns the full catalog (Anthropic, Amazon
 * Bedrock, Azure, Baseten, …), not only the connected providers that
 * `pi --list-models` reports.
 */
export async function listPiCatalogProviders(projectPath?: string): Promise<OfferedProvider[]> {
  const invocation = await prepareHarnessInvocation('pi', ['--mode', 'rpc'], {
    cwd: projectPath ?? homedir(),
    env: buildProcessEnvironment()
  })
  const client = new PiRpcClient({ invocation })
  try {
    await client.newSession()
    const payload = record(await client.getAvailableModels())
    const models = Array.isArray(payload?.['models']) ? payload['models'] : []
    const byProvider = new Map<string, number>()
    for (const raw of models) {
      const providerId = stringValue(record(raw)?.['provider'])
      if (!providerId) continue
      byProvider.set(providerId, (byProvider.get(providerId) ?? 0) + 1)
    }
    return [...byProvider.entries()].map(([id, modelCount]) => ({
      id,
      name: id,
      modelCount,
      authenticated: false
    }))
  } finally {
    client.dispose()
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
