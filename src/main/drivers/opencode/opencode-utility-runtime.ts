import type {
  PreparedUtilityRuntime,
  UtilityRuntimeOverlay,
  UtilityRuntimePreparationRequest
} from '../driver.interface'
import type { BaseUrlProviderService } from '../../providers/base-url-provider-service'
import { hasNativeProviderCatalog } from '../../agents/native-provider-config-service'
import type { SecretVault } from '../../storage/secret-vault'
import { leanAgentConfigMap } from '../../opencode/opencode-agent-definitions'
import { GATEWAY_UTILITY_ID_PREFIX } from '../../../lib/utility-ids'
import { STANDARD_THINKING_VARIANTS } from './opencode-models'
import { recordValue, utilityKey } from './opencode-values'

/**
 * Build the OpenCode utility runtime overlay: app-managed MCP servers, custom
 * base-URL provider config, and the lean agent definitions.
 */
export async function prepareOpenCodeUtilityRuntime(
  request: UtilityRuntimePreparationRequest,
  driverId: string,
  baseUrlProviders?: BaseUrlProviderService,
  secretVault?: SecretVault
): Promise<UtilityRuntimeOverlay> {
  const mcp: Record<string, Record<string, unknown>> = {}
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
        throw new TypeError(`OpenCode MCP utility "${utility.name}" requires a command`)
      }
      mcp[key] = {
        type: 'local',
        command: [config.command, ...(config.args ?? [])],
        environment: { ...(config.environment ?? {}) },
        enabled: true,
        // OpenCode's MCP client request timeout defaults to 60 seconds, which
        // is shorter than the app's own human-decision deadline: a
        // `cio_ask_secret` card still on screen would be abandoned mid-wait.
        // The app-owned gateway is the one server whose calls can be paced by
        // a human, so only it is raised, and only to the published deadline.
        ...(utility.id.startsWith(GATEWAY_UTILITY_ID_PREFIX) && request.gatewayRequestTimeoutMs
          ? { timeout: request.gatewayRequestTimeoutMs }
          : {})
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
      throw new TypeError(`OpenCode MCP utility "${utility.name}" requires a URL`)
    }
    mcp[key] = {
      type: 'remote',
      url,
      ...(utility.kind === 'mcp' && utility.config.headers
        ? { headers: utility.config.headers }
        : {}),
      enabled: true
    }
  }

  // ─── Custom base-URL providers ───────────────────────────────────────────
  // Resolve every enabled base-URL provider, vault its API key into a
  // deterministic env var, and merge the OpenCode-format provider config so
  // the models appear in the /models picker. This mirrors how OpenCode's own
  // opencode.json defines custom providers (npm, name, options, models).
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
        // Either bound is meaningful on its own (e.g. discovery often
        // reports only context_length)   requiring both dropped a known
        // context window whenever the output limit was missing.
        const limit = {
          ...(model.contextWindow ? { context: model.contextWindow } : {}),
          ...(model.maxOutputTokens ? { output: model.maxOutputTokens } : {})
        }
        // opencode dispatches by passing the thread's thinking level
        // straight through as the variant key, so the key must equal the
        // level it selects   `thinkingLevel` in the value is what opencode
        // itself reads to know which effort to actually request.
        const variants =
          model.thinkingPresets && model.thinkingPresets.length > 0
            ? model.thinkingPresets.map((p) => [p.id, { thinkingLevel: p.id }])
            : model.reasoning || model.defaultThinkingLevel
              ? STANDARD_THINKING_VARIANTS.map((p) => [p.id, { thinkingLevel: p.id }])
              : []
        models[model.id] = {
          name: model.name,
          ...(model.reasoning ? { reasoning: true } : {}),
          ...(Object.keys(limit).length > 0 ? { limit } : {}),
          ...(variants.length > 0 ? { variants: Object.fromEntries(variants) } : {}),
          // Unset `vision` is treated as capable everywhere else in this
          // codebase; mirror that here rather than opencode's own default.
          modalities: {
            input: model.vision === false ? ['text'] : ['text', 'image'],
            output: ['text']
          }
        }
      }
      provider[custom.id] = {
        npm: custom.npm,
        name: custom.name,
        options,
        models
      }
    }
  }

  // Prompts name CodeInOven's lean agents directly. Keep those definitions
  // in the app-owned server environment so inbox chat does not depend on a
  // successful rewrite of the user's global OpenCode config. That rewrite
  // may be skipped for JSONC or user-owned entries, but the prompt path must
  // remain deterministic in every case.
  return {
    env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ agent: leanAgentConfigMap(), mcp, provider }),
      ...baseUrlEnv
    }
  }
}

/**
 * OpenCode validates every provider in OPENCODE_CONFIG_CONTENT at startup.
 * Keep utility-provided entries, but expose only the custom provider selected
 * for this turn so a broken unrelated provider cannot block prompt sending.
 */
export function narrowOpenCodeRuntimeForProvider(
  runtime: PreparedUtilityRuntime,
  selectedProviderId: string,
  customProviders: ReadonlyArray<{ id: string; apiKeyEnvVar?: string }>
): PreparedUtilityRuntime {
  if (customProviders.length === 0) return runtime

  const configContent = runtime.env['OPENCODE_CONFIG_CONTENT']
  if (!configContent) return runtime
  let config: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(configContent) as unknown
    config = recordValue(parsed)
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
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config)
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
