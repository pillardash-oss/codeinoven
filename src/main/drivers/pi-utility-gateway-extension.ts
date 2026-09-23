/**
 * Generated TypeScript source for the app-owned Pi utility gateway extension.
 *
 * Pi has no native MCP host, so the utility gateway cannot be transported as an
 * MCP server the way Claude Code's `--mcp-config` path does it. Instead this
 * extension registers the interactive gateway tools from `GATEWAY_TOOLS` as
 * first-class Pi tools, so the model gets real structured tool affordances
 * instead of relying on the prose "curl" instructions injected into the system
 * prompt.
 *
 * Tool names, descriptions, and routes are interpolated from the canonical
 * catalog in `src/lib/gateway-tools.ts`, so updating that catalog updates
 * this extension everywhere   no surface can drift.
 *
 * Visibility contract: pi's system prompt lists a custom tool only when it
 * carries a `promptSnippet`. The three always-on tools (find/init/use) carry
 * one so the model discovers them on every turn. `cio_util_manage` and
 * `cio_util_diagnose` are registered WITHOUT a snippet: they stay callable
 * whenever an explicit @cio-utility setup turn names them in prose, but they
 * never advertise themselves during ordinary work.
 *
 * The gateway URL and bearer token are turn-scoped, while a Pi session process
 * persists across turns   extensions load at spawn, so their source cannot
 * embed per-turn credentials. The driver therefore publishes a small handoff
 * file (`{ url, token }`) before each direct-gateway turn and clears it on turn
 * cleanup. The extension reads the file lazily on every call, so a rewritten
 * handoff is picked up by the long-lived process, and a cleared handoff makes
 * stale tokens unusable after the turn ends.
 *
 * Self-healing: when a call fails, the extension re-reads the handoff once and
 * retries against the freshly read credentials, since the driver may have
 * rotated them between the read and the request. A recognized-but-rejected
 * token (404) is NOT recoverable client-side: the turn credentials were cleaned
 * up, so the tool says so plainly instead of letting the model guess.
 */

import {
  ASK_SECRET_TOOL_NAME,
  GATEWAY_TOOLS,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME,
  type GatewayToolDefinition
} from '../../lib/gateway-tools'

/** The gateway tools the extension registers as first-class Pi tools. */
export const PI_UTILITY_GATEWAY_TOOL_NAMES = [
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  ASK_SECRET_TOOL_NAME,
  UTILITY_MANAGE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME
] as const

function gatewayTool(name: string): GatewayToolDefinition {
  const definition = GATEWAY_TOOLS.find((tool) => tool.name === name)
  if (!definition) throw new Error(`Gateway tool ${name} is missing from GATEWAY_TOOLS`)
  return definition
}

const searchTool = gatewayTool(UTILITY_SEARCH_TOOL_NAME)
const activateTool = gatewayTool(UTILITY_ACTIVATE_TOOL_NAME)
const invokeTool = gatewayTool(UTILITY_INVOKE_TOOL_NAME)
const docsTool = gatewayTool(UTILITY_DOCS_TOOL_NAME)
const askSecretTool = gatewayTool(ASK_SECRET_TOOL_NAME)
const manageTool = gatewayTool(UTILITY_MANAGE_TOOL_NAME)
const diagnosticsTool = gatewayTool(UTILITY_DIAGNOSTICS_TOOL_NAME)

export function piUtilityGatewayExtension(): string {
  return `import { readFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

interface GatewayHandoff {
  url: string
  token: string
}

const HANDOFF_PATH = '__HANDOFF_PATH__'

interface GatewayFailure extends Error {
  gatewayInactive?: boolean
}

function fail(message: string, marker: 'gatewayInactive'): GatewayFailure {
  const error = new Error(message) as GatewayFailure
  error[marker] = true
  return error
}

async function loadHandoff(): Promise<GatewayHandoff> {
  let raw: string
  try {
    raw = await readFile(HANDOFF_PATH, 'utf8')
  } catch (error) {
    // The file is gone when the app already tore this turn's gateway down (turn
    // finalization, a mid-turn revoke, a transient session restart), and the
    // extension cannot re-arm itself: the turn's token lives in the app. Never
    // let the raw ENOENT reach the model: it reads as a broken file, not a
    // broken transport, and costs a turn of pointless retries.
    const reason = error instanceof Error ? error.message : String(error)
    throw fail(
      'The CodeInOven utility gateway is not active for this turn: its handoff file is unavailable (' + reason + '). The application must refresh the utility transport before continuing utility work; retrying this tool will not help.',
      'gatewayInactive'
    )
  }
  const handoff = JSON.parse(raw) as GatewayHandoff
  // An empty handoff is the seed written before the first real endpoint publish,
  // and a missing file means the previous turn's cleanup already ran. Both are
  // the "gateway not active this turn" case, never an opaque crash.
  if (!handoff.url || !handoff.token) {
    throw fail(
      'The CodeInOven utility gateway is not active for this turn: no gateway credentials were published (this happens on queued or steer turns, or before the first utility turn). The application must refresh the utility transport before continuing utility work.',
      'gatewayInactive'
    )
  }
  return handoff
}

function postJson(base: string, token: string, route: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const url = new URL(route, base)
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Content-Length': Buffer.byteLength(payload).toString()
        }
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            reject(new Error('Utility gateway returned a non-JSON response'))
            return
          }
          const record = parsed
          if (typeof record?.error === 'string') {
            if (response.statusCode === 404 && record.error === 'Not found') {
              // The listener is alive but does not know this turn's token  
              // the utility turn was already cleaned up. Host discovery cannot
              // help: the credentials are gone, only a fresh turn re-arms them.
              reject(
                fail(
                  'The CodeInOven utility gateway is not active for this turn: the turn credentials were already cleaned up (this happens on queued or steer turns). The application must refresh the utility transport before continuing utility work.',
                  'gatewayInactive'
                )
              )
              return
            }
            reject(new Error(record.error))
            return
          }
          resolve(parsed)
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs ?? 60_000, () => {
      req.destroy(new Error('Utility gateway request timed out'))
    })
    req.end(payload)
  })
}

async function callGateway(route: string, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
  const first = await loadHandoff()
  try {
    return await postJson(first.url, first.token, route, body, timeoutMs)
  } catch (error) {
    // Re-read even after a rejected token: the next turn may have published
    // fresh credentials before the rejection arrived.
    // The credentials may have been rotated between the read and the request
    // (a new turn raced this call)   retry once against a freshly read handoff.
    let fresh: GatewayHandoff
    try {
      fresh = await loadHandoff()
    } catch (handoffError) {
      throw handoffError
    }
    if (fresh.url !== first.url || fresh.token !== first.token) {
      try {
        return await postJson(fresh.url, fresh.token, route, body, timeoutMs)
      } catch (retryError) {
        if (retryError && retryError.gatewayInactive) throw retryError
        throw retryError
      }
    }
    if (error && error.gatewayInactive) throw error
    throw error
  }
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  }
}

/**
 * Hand a collected secret's values to this session without ever showing them to
 * the model: they are applied to the pi process environment here and dropped
 * from the tool result the model reads.
 */
function applySecretEnvironment(result) {
  if (!result || typeof result !== 'object') return result
  const environment = result.environment
  const { environment: _ignored, ...safe } = result
  if (!environment || typeof environment !== 'object') return safe
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      process.env[name] = value
    }
  }
  return safe
}

export default function codeInOvenUtilityGatewayExtension(pi) {
  pi.registerTool({
    name: ${JSON.stringify(searchTool.name)},
    label: 'Search CodeInOven utilities',
    description: ${JSON.stringify(searchTool.description)},
    promptSnippet: 'Search app-managed utilities (MCP servers, skills, web services, computer-use) by capability name or task intent',
    promptGuidelines: [
      'Before concluding that any capability (MCP, skill, tool, utility) is unavailable or does not exist, call ${UTILITY_SEARCH_TOOL_NAME} first; only conclude unavailability when the search result reports notFound:true. Never treat "the tools are not exposed in this session" as proof of absence.'
    ],
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
      const body = { query: params.query }
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
    promptSnippet: 'Activate an installed app utility for the current turn',
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
    promptSnippet: 'Invoke an operation on an app utility activated for the current turn',
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

  // Post-compaction docs re-dump: registered without a promptSnippet so it
  // stays out of the always-on system prompt, but always callable when the
  // turn instructions mention the thread utilities bank.
  pi.registerTool({
    name: ${JSON.stringify(docsTool.name)},
    label: 'Re-list CodeInOven utility docs',
    description: ${JSON.stringify(docsTool.description)},
    parameters: Type.Object({
      utility_id: Type.String({ description: 'Utility identifier, e.g. from the thread utilities bank.' })
    }),
    async execute(_toolCallId, params) {
      const result = await callGateway(${JSON.stringify(docsTool.route)}, { utility_id: params.utility_id })
      return textResult(result)
    }
  })

  // Secret collection: the app owns the card, the vault and the utility
  // credential, so the tool result carries only the names the model
  // interpolates. It is announced on every turn because a task can need a
  // credential at any point, not only during setup.
  pi.registerTool({
    name: ${JSON.stringify(askSecretTool.name)},
    label: 'Collect a secret from the user',
    description: ${JSON.stringify(askSecretTool.description)},
    promptSnippet: 'Ask the user for a secret value (API key, token, password) without ever seeing it',
    promptGuidelines: [
      'Never ask the user to paste a secret into chat. When you need a value you do not have (an API key, token, or password), call ${JSON.stringify(askSecretTool.name)} with one entry per secret and a short title.',
      'Pass environment_variable when the target expects a specific name (an MCP server variable, a CLI flag); otherwise you receive a derived CIO_ name.',
      'Pass utility_id to bind the value to an installed capability as its credential, exactly as the Utilities page stores it; do this right after installing a capability that needs one.',
      'The result names the environment variable and, for a plain value, a 0600 secret_path: reference them at the target as $ENVIRONMENT_VARIABLE or "$(cat secret_path)". Never print, echo, log, or read the value, and never paste it into chat.'
    ],
    parameters: Type.Object({
      secrets: Type.Array(
        Type.Object({
          title: Type.String({ description: 'Short human label, e.g. "Authorization Key".' }),
          description: Type.Optional(
            Type.String({ description: 'One line on what the value is and where to obtain it.' })
          ),
          environment_variable: Type.Optional(
            Type.String({
              description:
                'Environment variable name the target expects. Omit to receive a derived CIO_ name.'
            })
          ),
          utility_id: Type.Optional(
            Type.String({
              description: 'Installed utility id to bind this secret to as its credential.'
            })
          )
        }),
        { description: 'Secrets to collect, in order.', minItems: 1, maxItems: 5 }
      )
    }),
    async execute(_toolCallId, params) {
      const result = await callGateway(
        ${JSON.stringify(askSecretTool.route)},
        { secrets: params.secrets, apply_environment: true },
        // The card is human-paced, so this call must outlive a short request
        // timeout; ten minutes still bounds a turn that is truly abandoned.
        600000
      )
      return textResult(applySecretEnvironment(result))
    }
  })

  // Setup/diagnostics tools: registered without a promptSnippet so they stay
  // out of the always-on system prompt, but remain callable whenever an
  // explicit @cio-utility turn names them in prose. The gateway server still
  // enforces allowManagement, so ordinary turns cannot misuse them.
  pi.registerTool({
    name: ${JSON.stringify(manageTool.name)},
    label: 'Install a CodeInOven utility bundle',
    description: ${JSON.stringify(manageTool.description)},
    parameters: Type.Object({
      action: Type.Literal('install_bundle'),
      // Deliberately permissive: the nested shape documents the contract for the
      // model, while optional fields and additionalProperties keep a flat or
      // aliased entry from being rejected by schema validation before the
      // gateway's own tolerant parser can normalise it.
      bundle: Type.Object(
        {
          name: Type.Optional(Type.String({ description: 'Human-readable bundle name.' })),
          utilities: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  definition: Type.Optional(
                    Type.Object(
                      {
                        kind: Type.Optional(Type.Union([Type.Literal('skill'), Type.Literal('mcp')])),
                        name: Type.Optional(Type.String({ description: 'Utility name.' })),
                        description: Type.Optional(Type.String()),
                        enabled: Type.Optional(Type.Boolean()),
                        activation: Type.Optional(
                          Type.Union([Type.Literal('on_demand'), Type.Literal('always')])
                        ),
                        config: Type.Optional(
                          Type.Object(
                            {},
                            {
                              additionalProperties: true,
                              description:
                                'MCP: {"transport":"http"|"sse","url":"https://..."} or {"transport":"stdio","command":"...","args":[...]}.'
                            }
                          )
                        )
                      },
                      {
                        additionalProperties: true,
                        description: 'The utility itself: "kind" must be "skill" or "mcp".'
                      }
                    )
                  )
                },
                {
                  additionalProperties: true,
                  description: 'A single entry: {"definition":{"kind":"skill"|"mcp",...}}.'
                }
              ),
              { minItems: 1, maxItems: 20, description: 'One entry per utility.' }
            )
          )
        },
        {
          additionalProperties: true,
          description:
            'The bundle to install: a name plus one entry per utility, each {"definition":{...}}.'
        }
      )
    }),
    async execute(_toolCallId, params) {
      const result = await callGateway(${JSON.stringify(manageTool.route)}, {
        action: params.action,
        bundle: params.bundle
      })
      return textResult(result)
    }
  })

  pi.registerTool({
    name: ${JSON.stringify(diagnosticsTool.name)},
    label: 'Run CodeInOven app diagnostics',
    description: ${JSON.stringify(diagnosticsTool.description)},
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('lookup_thread'),
        Type.Literal('search_threads'),
        Type.Literal('read_messages'),
        Type.Literal('read_log'),
        Type.Literal('list_schema'),
        Type.Literal('query_sql')
      ]),
      query: Type.Optional(Type.String()),
      thread_id: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      level: Type.Optional(Type.String()),
      file: Type.Optional(Type.String()),
      table: Type.Optional(Type.String()),
      sql: Type.Optional(Type.String()),
      params: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])))
    }),
    async execute(_toolCallId, params) {
      const body = { action: params.action }
      if (params.query !== undefined) body.query = params.query
      if (params.thread_id !== undefined) body.thread_id = params.thread_id
      if (params.limit !== undefined) body.limit = params.limit
      if (params.level !== undefined) body.level = params.level
      if (params.file !== undefined) body.file = params.file
      if (params.table !== undefined) body.table = params.table
      if (params.sql !== undefined) body.sql = params.sql
      if (params.params !== undefined) body.params = params.params
      const result = await callGateway(${JSON.stringify(diagnosticsTool.route)}, body)
      return textResult(result)
    }
  })
}
`
}
