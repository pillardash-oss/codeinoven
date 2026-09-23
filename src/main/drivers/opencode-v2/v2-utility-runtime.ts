import type {
  PreparedUtilityRuntime,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from '../driver.interface'
import type { BaseUrlProviderService } from '../../providers/base-url-provider-service'
import { hasNativeProviderCatalog } from '../../agents/native-provider-config-service'
import type { SecretVault } from '../../storage/secret-vault'
import { STANDARD_THINKING_VARIANTS } from '../opencode/opencode-models'
import { utilityKey } from '../opencode/opencode-values'
import { OPENCODE_V2_CONFIG_CONTENT_ENV } from '../../opencode-v2/opencode-v2-server'
import { leanAgentV2ConfigMap } from './v2-agents'
import { recordValue } from './v2-values'

/** The inline config document one prepared V2 runtime materializes. */
export function openCodeV2ConfigContent(runtime: PreparedUtilityRuntime): string | undefined {
  return runtime.env[OPENCODE_V2_CONFIG_CONTENT_ENV]
}

/**
 * Build the V2 utility runtime overlay: app-managed MCP servers, custom
 * base-URL provider config, and the lean agent definitions.
 *
 * V2 reads one inline document from `OPENCODE_CONFIG_CONTENT`. Its schema uses
 * the plural `agents` and the nested `mcp.servers` container, while provider
 * entries written in the V1 (`provider` with `npm`/`options`) dialect are
 * normalized into V2's `providers` form by the harness itself   verified live
 * against `opencode v2.0.14`, which also resolves the `{env:NAME}` api-key
 * template. Keeping the provider block in the dialect both versions accept is
 * what lets one config document serve either binary.
 */
export async function prepareOpenCodeV2UtilityRuntime(
  request: UtilityRuntimePreparationRequest,
  driverId: string,
  baseUrlProviders?: BaseUrlProviderService,
  secretVault?: SecretVault
): Promise<UtilityRuntimeOverlay> {
  const servers: Record<string, Record<string, unknown>> = {}
  const provider: Record<string, Record<string, unknown>> = {}
  const keys = new Set<string>()
  for (const { utility, binding } of request.resolvedUtilities) {
    if (utility.kind === 'provider' && binding.strategy === 'provider') {
      const environmentVariable = utility.credentials.find(
        (credential) => credential.environmentVariable
      )?.environmentVariable
      provider[utility.config.providerId] = {
        ...(utility.config.endpoint || environmentVariable
          ? {
              options: {
                ...(utility.config.endpoint ? { baseURL: utility.config.endpoint } : {}),
                ...(environmentVariable ? { apiKey: `{env:${environmentVariable}}` } : {})
              }
            }
          : {}),
        ...(utility.config.defaultModel
          ? {
              models: {
                [utility.config.defaultModel]: { name: utility.config.defaultModel }
              }
            }
          : {})
      }
      continue
    }
    if (binding.strategy !== 'mcp') continue
    const baseKey = utilityKey(binding.transportName ?? utility.name)
    let key = baseKey
    for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
    keys.add(key)

    if (utility.kind === 'mcp' && utility.config.transport === 'stdio') {
      const config = utility.config
      if (!config.command) {
        throw new TypeError(`OpenCode V2 MCP utility "${utility.name}" requires a command`)
      }
      servers[key] = {
        type: 'local',
        command: [config.command, ...(config.args ?? [])],
        environment: { ...(config.environment ?? {}) }
      }
      continue
    }
    const url =
      utility.kind === 'mcp'
        ? utility.config.url
        : utility.kind === 'web_search' ||
            utility.kind === 'web_fetch' ||
            utility.kind === 'computer_use'
          ? utility.config.endpoint
          : undefined
    if (!url) {
      throw new TypeError(`OpenCode V2 MCP utility "${utility.name}" requires a URL`)
    }
    servers[key] = {
      type: 'remote',
      url,
      ...(utility.kind === 'mcp' && utility.config.headers
        ? { headers: utility.config.headers }
        : {})
    }
  }

  // ─── Custom base-URL providers ───────────────────────────────────────────
  // Resolve every enabled base-URL provider assigned to this harness, vault its
  // API key into a deterministic env var, and merge the V1-dialect provider
  // config V2 normalizes so the models appear in the model list.
  const baseUrlEnv: Record<string, string> = {}
  if (baseUrlProviders && secretVault && !hasNativeProviderCatalog(driverId)) {
    const customProviders = await baseUrlProviders.listEnabled(driverId)
    for (const custom of customProviders) {
      const options: Record<string, unknown> = { baseURL: custom.baseURL }
      if (custom.apiKeyRef && custom.apiKeyEnvVar) {
        const apiKey = await secretVault.resolve(custom.apiKeyRef)
        baseUrlEnv[custom.apiKeyEnvVar] = apiKey
        options.apiKey = `{env:${custom.apiKeyEnvVar}}`
      }
      if (custom.headers) options.headers = custom.headers
      const models: Record<string, Record<string, unknown>> = {}
      for (const model of custom.models) {
        // Either limit bound is meaningful on its own; requiring both dropped a
        // known context window whenever the output limit was missing.
        const limit = {
          ...(model.contextWindow ? { context: model.contextWindow } : {}),
          ...(model.maxOutputTokens ? { output: model.maxOutputTokens } : {})
        }
        // V2 dispatches a variant by id, and the app's thinking levels are the
        // variant ids, so the key must equal the level it selects.
        const variants =
          model.thinkingPresets && model.thinkingPresets.length > 0
            ? model.thinkingPresets.map((preset) => [preset.id, { thinkingLevel: preset.id }])
            : model.reasoning || model.defaultThinkingLevel
              ? STANDARD_THINKING_VARIANTS.map((preset) => [
                  preset.id,
                  { thinkingLevel: preset.id }
                ])
              : []
        models[model.id] = {
          name: model.name,
          ...(model.reasoning ? { reasoning: true } : {}),
          ...(Object.keys(limit).length > 0 ? { limit } : {}),
          ...(variants.length > 0 ? { variants: Object.fromEntries(variants) } : {}),
          // Unset `vision` is treated as capable everywhere else in this
          // codebase; mirror that rather than the harness's own default.
          modalities: {
            input: model.vision === false ? ['text'] : ['text', 'image'],
            output: ['text']
          }
        }
      }
      provider[custom.id] = { npm: custom.npm, name: custom.name, options, models }
    }
  }

  // Prompts name CodeInOven's lean agents directly, so their definitions live in
  // the app-owned server config instead of depending on the user's own config
  // file: the prompt path stays deterministic in every case.
  return {
    env: {
      [OPENCODE_V2_CONFIG_CONTENT_ENV]: JSON.stringify({
        agents: leanAgentV2ConfigMap(),
        mcp: { servers },
        provider
      }),
      ...baseUrlEnv
    }
  }
}

/**
 * V2 validates every provider in `OPENCODE_CONFIG_CONTENT` when a location
 * boots, so keep utility-provided entries but expose only the custom provider
 * selected for this turn: a broken unrelated provider must not block prompt
 * sending.
 */
export function narrowOpenCodeV2RuntimeForProvider(
  runtime: PreparedUtilityRuntime,
  selectedProviderId: string,
  customProviders: ReadonlyArray<{ id: string; apiKeyEnvVar?: string }>
): PreparedUtilityRuntime {
  if (customProviders.length === 0) return runtime

  const configContent = openCodeV2ConfigContent(runtime)
  if (!configContent) return runtime
  let config: Record<string, unknown> | undefined
  try {
    config = recordValue(JSON.parse(configContent) as unknown)
  } catch {
    return runtime
  }
  if (!config) return runtime

  const customIds = new Set(customProviders.map((provider) => provider.id))
  const configuredProviders = recordValue(config['provider']) ?? {}
  config['provider'] = Object.fromEntries(
    Object.entries(configuredProviders).filter(
      ([id]) => !customIds.has(id) || id === selectedProviderId
    )
  )
  const env: Record<string, string> = {
    ...runtime.env,
    [OPENCODE_V2_CONFIG_CONTENT_ENV]: JSON.stringify(config)
  }
  for (const provider of customProviders) {
    if (provider.id === selectedProviderId || !provider.apiKeyEnvVar) continue
    delete env[provider.apiKeyEnvVar]
  }
  return {
    ...runtime,
    id: `${runtime.id}:provider:${selectedProviderId}`,
    env
  }
}
