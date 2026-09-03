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
 * this extension everywhere — no surface can drift.
 *
 * Visibility contract: pi's system prompt lists a custom tool only when it
 * carries a `promptSnippet`. The three always-on tools (find/init/use) carry
 * one so the model discovers them on every turn. `cio_util_manage` and
 * `cio_util_diagnose` are registered WITHOUT a snippet: they stay callable
 * whenever an explicit @cio-utility setup turn names them in prose, but they
 * never advertise themselves during ordinary work.
 *
 * The gateway URL and bearer token are turn-scoped, while a Pi session process
 * persists across turns — extensions load at spawn, so their source cannot
 * embed per-turn credentials. The driver therefore publishes a small handoff
 * file (`{ url, token }`) before each direct-gateway turn and clears it on turn
 * cleanup. The extension reads the file lazily on every call, so a rewritten
 * handoff is picked up by the long-lived process, and a cleared handoff makes
 * stale tokens unusable after the turn ends.
 *
 * Self-healing: when a call fails, the extension re-reads the handoff once
 * (the driver may have rotated credentials between the read and the request)
 * and, when the gateway host itself is unreachable, discovers the live
 * instance's `mcpHost` through the same shell resolver the prose fallback
 * used — the session id and resolver path are embedded at materialization
 * time. A recognized-but-rejected token (404) is NOT recoverable client-side:
 * the turn credentials were cleaned up, so the tool says so plainly instead of
 * letting the model guess.
 */

import {
  GATEWAY_TOOLS,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME,
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
const manageTool = gatewayTool(UTILITY_MANAGE_TOOL_NAME)
const diagnosticsTool = gatewayTool(UTILITY_DIAGNOSTICS_TOOL_NAME)

export function piUtilityGatewayExtension(): string {
  return `import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

interface GatewayHandoff {
  url: string
  token: string
}

const HANDOFF_PATH = '__HANDOFF_PATH__'
const SESSION_ID = '__CIO_SESSION_ID__'
const RETRIEVE_SCRIPT = '__CIO_RETRIEVE_SCRIPT__'

interface GatewayFailure extends Error {
  gatewayInactive?: boolean
}

function fail(message: string, marker: 'gatewayInactive'): GatewayFailure {
  const error = new Error(message) as GatewayFailure
  error[marker] = true
  return error
}

function loadHandoff(): GatewayHandoff {
  const handoff = JSON.parse(readFileSync(HANDOFF_PATH, 'utf8')) as GatewayHandoff
  // An empty handoff is the seed written before the first real endpoint publish,
  // and a missing file means the previous turn's cleanup already ran — both are
  // the "gateway not active this turn" case, never an opaque crash.
  if (!handoff.url || !handoff.token) {
    throw fail(
      'The CodeInOven utility gateway is not active for this turn: no gateway credentials were published (this happens on queued or steer turns, or before the first utility turn). Continue without app utilities; the next regular user turn re-arms them.',
      'gatewayInactive'
    )
  }
  return handoff
}

function postJson(base: string, token: string, route: string, body: Record<string, unknown>): Promise<unknown> {
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
              // The listener is alive but does not know this turn's token —
              // the utility turn was already cleaned up. Host discovery cannot
              // help: the credentials are gone, only a fresh turn re-arms them.
              reject(
                fail(
                  'The CodeInOven utility gateway is not active for this turn: the turn credentials were already cleaned up (this happens on queued or steer turns). Continue without app utilities; the next regular user turn re-arms them.',
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
    req.setTimeout(60_000, () => {
      req.destroy(new Error('Utility gateway request timed out'))
    })
    req.end(payload)
  })
}

/** Discover the live instance's loopback gateway host through the shell
 *  resolver the prose fallback used. Returns null when unavailable. */
function discoverGatewayHost(): Promise<string | null> {
  if (!RETRIEVE_SCRIPT || !SESSION_ID) return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [RETRIEVE_SCRIPT, SESSION_ID],
      { timeout: 4000 },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        try {
          const parsed = JSON.parse(stdout)
          const host = parsed?.mcpHost
          resolve(typeof host === 'string' && host.startsWith('http://127.0.0.1') ? host : null)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

async function callGateway(route: string, body: Record<string, unknown>): Promise<unknown> {
  const first = loadHandoff()
  try {
    return await postJson(first.url, first.token, route, body)
  } catch (error) {
    if (error && error.gatewayInactive) throw error
    // The credentials may have been rotated between the read and the request
    // (a new turn raced this call) — retry once against a freshly read handoff.
    let fresh: GatewayHandoff
    try {
      fresh = loadHandoff()
    } catch (handoffError) {
      throw handoffError
    }
    if (fresh.url !== first.url || fresh.token !== first.token) {
      try {
        return await postJson(fresh.url, fresh.token, route, body)
      } catch (retryError) {
        if (retryError && retryError.gatewayInactive) throw retryError
        throw retryError
      }
    }
    // Host-level recovery: the app may have restarted and moved the loopback
    // port while this long-lived session kept the old handoff.
    const host = await discoverGatewayHost()
    if (host && host !== fresh.url) {
      try {
        return await postJson(host, fresh.token, route, body)
      } catch (recoveredError) {
        if (recoveredError && recoveredError.gatewayInactive) throw recoveredError
      }
    }
    throw error
  }
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  }
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
      bundle: Type.Record(Type.String(), Type.Unknown(), {
        description: 'A UtilityBundleInstallRequest-shaped object with name and one or more secret-free definition entries.'
      })
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
        Type.Literal('read_log')
      ]),
      query: Type.Optional(Type.String()),
      thread_id: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number()),
      level: Type.Optional(Type.String()),
      file: Type.Optional(Type.String())
    }),
    async execute(_toolCallId, params) {
      const body = { action: params.action }
      if (params.query !== undefined) body.query = params.query
      if (params.thread_id !== undefined) body.thread_id = params.thread_id
      if (params.limit !== undefined) body.limit = params.limit
      if (params.level !== undefined) body.level = params.level
      if (params.file !== undefined) body.file = params.file
      const result = await callGateway(${JSON.stringify(diagnosticsTool.route)}, body)
      return textResult(result)
    }
  })
}
`
}
