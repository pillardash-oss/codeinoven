import type { BaseUrlProviderModel } from '../../lib/types'
import type { GatewayModelInfo } from '../../lib/gateway-types'
import type { BaseUrlProviderService } from '../providers/base-url-provider-service'

/**
 * Per-harness binding for a gateway's OpenAI/Anthropic-compatible endpoints.
 *
 * The `npm` value selects each driver's wire behaviour (e.g. Codex maps
 * `@ai-sdk/openai` to the Responses wire API; Claude Code always speaks
 * Anthropic at the root URL without `/v1`).
 */
interface HarnessGatewayBinding {
  harnessId: string
  npm: string
  pathSuffix: string
}

const HARNESS_BINDINGS: HarnessGatewayBinding[] = [
  { harnessId: 'codex', npm: '@ai-sdk/openai', pathSuffix: '/v1' },
  { harnessId: 'claude-code', npm: '@ai-sdk/anthropic', pathSuffix: '' },
  { harnessId: 'opencode', npm: '@ai-sdk/openai-compatible', pathSuffix: '/v1' },
  { harnessId: 'pi', npm: '@ai-sdk/openai-compatible', pathSuffix: '/v1' },
  { harnessId: 'cline', npm: '@ai-sdk/openai-compatible', pathSuffix: '/v1' }
]

/** Deterministic custom-provider id for one gateway/harness pair. */
export function gatewayProviderId(pluginId: string, harnessId: string): string {
  return `${pluginId}-${harnessId}`
}

const MODELS_MAX = 128

type ProviderModelInput = Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }

function toProviderModels(models: GatewayModelInfo[]): ProviderModelInput[] {
  const trimmed = models.slice(0, MODELS_MAX)
  if (trimmed.length === 0) {
    return [{ id: 'auto', name: 'Gateway default', reasoning: false }]
  }
  return trimmed.map((model) => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    ...(model.vision === undefined ? {} : { vision: model.vision })
  }))
}

/**
 * Create or refresh one custom base-URL provider per supported harness so the
 * existing driver endpoint injection picks the gateway up with zero driver
 * changes. Preserves a previously vaulted API key reference when refreshing.
 */
export async function syncGatewayProviders(
  providers: BaseUrlProviderService,
  pluginId: string,
  adapterName: string,
  rootUrl: string,
  models: GatewayModelInfo[]
): Promise<string[]> {
  const synced: string[] = []
  for (const binding of HARNESS_BINDINGS) {
    const id = gatewayProviderId(pluginId, binding.harnessId)
    const current = await providers.getProvider(binding.harnessId, id)
    if (current) {
      await providers.updateProvider(binding.harnessId, id, {
        npm: binding.npm,
        name: `${adapterName} (gateway)`,
        baseURL: `${rootUrl}${binding.pathSuffix}`,
        models: toProviderModels(models),
        enabled: true
      })
    } else {
      await providers.createProvider({
        id,
        harnessId: binding.harnessId,
        npm: binding.npm,
        name: `${adapterName} (gateway)`,
        baseURL: `${rootUrl}${binding.pathSuffix}`,
        models: toProviderModels(models),
        enabled: true
      })
    }
    synced.push(binding.harnessId)
  }
  return synced
}

/** Remove every harness provider record previously synced for this gateway. */
export async function removeGatewayProviders(
  providers: BaseUrlProviderService,
  pluginId: string
): Promise<void> {
  for (const binding of HARNESS_BINDINGS) {
    const id = gatewayProviderId(pluginId, binding.harnessId)
    const current = await providers.getProvider(binding.harnessId, id)
    if (!current) continue
    await providers.deleteProvider(binding.harnessId, id)
  }
}
