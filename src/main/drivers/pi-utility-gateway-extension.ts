/**
 * Generated TypeScript source for the app-owned Pi utility gateway extension.
 *
 * Pi has no native MCP host, so the utility gateway cannot be transported as an
 * MCP server the way Claude Code's `--mcp-config` path does it. Instead this
 * extension registers the interactive gateway tools from `GATEWAY_TOOLS` as
 * first-class Pi tools, so the model gets real structured tool affordances
 * instead of relying only on the prose "curl" instructions injected into the
 * system prompt.
 *
 * Tool names, descriptions, and routes are interpolated from the canonical
 * catalog in `src/lib/gateway-tools.ts`, so updating that catalog updates
 * this extension everywhere — no surface can drift.
 *
 *
 * The gateway URL and bearer token are turn-scoped, while a Pi session process
 * persists across turns — extensions load at spawn, so their source cannot
 * embed per-turn credentials. The driver therefore publishes a small handoff
 * file (`{ url, token }`) before each direct-gateway turn and clears it on turn
 * cleanup. The extension reads the file lazily on every call, so a rewritten
 * handoff is picked up by the long-lived process, and a cleared handoff makes
 * stale tokens unusable after the turn ends.
 *
 * The prose fallback instructions stay in place: this extension is an
 * affordance upgrade, not a replacement of the documented shell path.
 */

import {
  GATEWAY_TOOLS,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME,
  type GatewayToolDefinition
} from '../../lib/gateway-tools'

/** The gateway tools the extension registers as first-class Pi tools. */
export const PI_UTILITY_GATEWAY_TOOL_NAMES = [
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME
] as const

function gatewayTool(name: string): GatewayToolDefinition {
  const definition = GATEWAY_TOOLS.find((tool) => tool.name === name)
  if (!definition) throw new Error(`Gateway tool ${name} is missing from GATEWAY_TOOLS`)
  return definition
}

const searchTool = gatewayTool(UTILITY_SEARCH_TOOL_NAME)
const activateTool = gatewayTool(UTILITY_ACTIVATE_TOOL_NAME)
const invokeTool = gatewayTool(UTILITY_INVOKE_TOOL_NAME)

export function piUtilityGatewayExtension(): string {
  return `import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

interface GatewayHandoff {
  url: string
  token: string
}

const HANDOFF_PATH = '__HANDOFF_PATH__'

let cachedHandoff: { path: string; handoff: GatewayHandoff } | null = null

function loadHandoff(): GatewayHandoff {
  // Re-read unless the path itself changed: the driver rewrites the same file
  // per turn, so mtime granularity is not needed — a fresh read per call keeps
  // turn rotation correct without caching stale tokens.
  const handoff = JSON.parse(readFileSync(HANDOFF_PATH, 'utf8')) as GatewayHandoff
  cachedHandoff = { path: HANDOFF_PATH, handoff }
  return handoff
}

function handoffError(): Error {
  return new Error(
    'The CodeInOven utility gateway is not active for this turn. Use the shell fallback described in the app gateway instructions.'
  )
}

async function callGateway(
  route: string,
  body: Record<string, unknown>
): Promise<unknown> {
  let handoff: GatewayHandoff
  try {
    handoff = loadHandoff()
  } catch {
    throw handoffError()
  }
  const url = new URL(route, handoff.url)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + handoff.token,
          'Content-Length': Buffer.byteLength(payload).toString()
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(new Error('Utility gateway returned a non-JSON response'))
            return
          }
          const record = parsed as { error?: string }
          if (typeof record?.error === 'string') {
            reject(new Error(record.error))
            return
          }
          resolve(parsed)
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Utility gateway request timed out'))
    })
    req.end(payload)
  })
}

function textResult(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  }
}

export default function codeInOvenUtilityGatewayExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: ${JSON.stringify(searchTool.name)},
    label: 'Search CodeInOven utilities',
    description: ${JSON.stringify(searchTool.description)},
    parameters: Type.Object({
      query: Type.String({ description: 'Capability or task to search for.' }),
      kinds: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Optional kind filter, e.g. mcp, skill, computer_use, image_descriptor.'
        })
      ),
      limit: Type.Optional(Type.Number({ description: 'Maximum results (1-20).' }))
    }),
    async execute(_toolCallId, params) {
      const body: Record<string, unknown> = { query: params.query }
      if (params.kinds !== undefined) body.kinds = params.kinds
      if (params.limit !== undefined) body.limit = params.limit
      const result = await callGateway(${JSON.stringify(searchTool.route)}, body)
      return textResult(result)
    }
  })

  pi.registerTool({
    name: ${JSON.stringify(activateTool.name)},
    label: 'Activate CodeInOven utility',
    description: ${JSON.stringify(activateTool.description)},
    parameters: Type.Object({
      utility_id: Type.String({ description: 'Installed utility identifier.' })
    }),
    async execute(_toolCallId, params) {
      const result = await callGateway(${JSON.stringify(activateTool.route)}, { utility_id: params.utility_id })
      return textResult(result)
    }
  })

  pi.registerTool({
    name: ${JSON.stringify(invokeTool.name)},
    label: 'Invoke CodeInOven utility operation',
    description: ${JSON.stringify(invokeTool.description)},
    parameters: Type.Object({
      utility_id: Type.String({ description: 'Utility activated earlier this turn.' }),
      operation: Type.String({ description: 'Operation or tool name to invoke.' }),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
    }),
    async execute(_toolCallId, params) {
      const result = await callGateway(${JSON.stringify(invokeTool.route)}, {
        utility_id: params.utility_id,
        operation: params.operation,
        input: params.input ?? {}
      })
      return textResult(result)
    }
  })
}
`
}
