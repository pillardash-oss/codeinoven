import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  UTILITY_SUGGEST_TOOL_NAME
} from '../../../lib/gateway-tools'
import type { UtilityGatewayEndpoint } from '../../../lib/gateway-timeout'
import type { UtilityRuntimeOverlay, UtilityRuntimePreparationRequest } from '../driver.interface'
import { type CodexAppServerTurn } from '../codex/codex-protocol'
import { tomlString, tomlStringArray, tomlStringMap, utilityKey } from '../codex/codex-tools'
import { recordValue, stringValue } from '../codex/codex-values'
import type { CodexDriver } from '../codex-driver'

/** CodexDriver tools: one concern, moved verbatim from the composition root. */
export class CodexDriverTools {
  constructor(
    private readonly host: CodexDriver,
    private readonly base: CodexDriver['base']
  ) {}

  async publishUtilityGatewayEndpoint(
    _projectPath: string,
    sessionId: string,
    endpoint: UtilityGatewayEndpoint | null
  ): Promise<void> {
    if (endpoint) this.host.utilityEndpoints.set(sessionId, endpoint)
    else this.host.utilityEndpoints.delete(sessionId)
  }

  /** Resolve credentials from the owning session on every structured tool call. */
  async callUtilityTool(
    active: CodexAppServerTurn,
    params: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    try {
      const tool = GATEWAY_TOOLS.find(({ name }) => name === params['tool'])
      const endpoint = this.host.utilityEndpoints.get(active.session.id)
      if (
        !tool ||
        !endpoint ||
        active.finished ||
        (endpoint.toolNames !== undefined && !endpoint.toolNames.includes(tool.name))
      ) {
        throw new Error('The utility tool is not active for this turn')
      }
      const response = await fetch(`${endpoint.url}${tool.route}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify(recordValue(params['arguments']) ?? {}),
        // The secret and suggestion cards are human-paced, so those calls wait as
        // long as the app's own deadline   the endpoint carries it   while every
        // other tool stays bounded by the short gateway timeout.
        signal: AbortSignal.timeout(
          tool.name === ASK_SECRET_TOOL_NAME || tool.name === UTILITY_SUGGEST_TOOL_NAME
            ? endpoint.timeoutMs
            : 120_000
        )
      })
      const result: unknown = await response.json()
      const body = recordValue(result)
      if (!response.ok) {
        throw new Error(stringValue(body?.['error']) ?? 'Utility tool call failed')
      }
      const content = body?.['content']
      const contentItems = Array.isArray(content)
        ? content.map<Record<string, unknown>>((item: unknown) => {
            const entry = recordValue(item)
            if (entry?.['type'] === 'image' && typeof entry['data'] === 'string') {
              return {
                type: 'inputImage',
                imageUrl: `data:${stringValue(entry['mimeType']) ?? 'image/png'};base64,${entry['data']}`
              }
            }
            return { type: 'inputText', text: stringValue(entry?.['text']) ?? JSON.stringify(item) }
          })
        : [{ type: 'inputText', text: JSON.stringify(result) }]
      return { success: body?.['isError'] !== true, contentItems }
    } catch (error) {
      return {
        success: false,
        contentItems: [
          {
            type: 'inputText',
            text: error instanceof Error ? error.message : 'Utility tool call failed'
          }
        ]
      }
    }
  }

  async prepareUtilityRuntime(
    request: UtilityRuntimePreparationRequest
  ): Promise<UtilityRuntimeOverlay> {
    const args: string[] = []
    const keys = new Set<string>()
    const addOverride = (key: string, value: string): void => {
      args.push('-c', `${key}=${value}`)
    }

    for (const { utility, binding } of request.resolvedUtilities) {
      if (utility.kind !== 'mcp') continue
      const baseKey = utilityKey(binding.transportName ?? utility.name)
      let key = baseKey
      for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}_${suffix}`
      keys.add(key)

      const prefix = `mcp_servers.${key}`
      const config = utility.config
      if (config.transport === 'stdio') {
        if (!config.command) {
          throw new TypeError(`Codex MCP utility "${utility.name}" requires a command`)
        }
        addOverride(`${prefix}.command`, tomlString(config.command))
        if (config.args?.length) {
          addOverride(`${prefix}.args`, tomlStringArray(config.args))
        }
        if (config.environment && Object.keys(config.environment).length > 0) {
          addOverride(`${prefix}.env`, tomlStringMap(config.environment))
        }
        continue
      }
      if (!config.url) {
        throw new TypeError(`Codex MCP utility "${utility.name}" requires a URL`)
      }
      addOverride(`${prefix}.url`, tomlString(config.url))
    }

    return args.length > 0 ? { args } : {}
  }
}
