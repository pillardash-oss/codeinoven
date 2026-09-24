import type {
  HarnessUtilityBinding,
  ResolvedUtility,
  UtilityDefinitionFor
} from '../../../lib/types'
import { GATEWAY_TOOLS } from '../../../lib/gateway-tools'
import { DESIGN_OUTPUT_ROOT } from '../../../lib/design-skill'
import { GATEWAY_UTILITY_ID_PREFIX } from '../../../lib/utility-ids'
import type { McpTool } from '../../agents/mcp-stdio-client'

export const BRIDGE_SCRIPT_PATH = 'runtime/utility-gateway/bridge.mjs'

/**
 * Absolute cap on one gateway call, enforced by the bridge itself.
 *
 * The harness's own request timeout is the real lifetime bound, because it also sends
 * `notifications/cancelled` when it gives up, and the bridge aborts the named call on that
 * signal. This cap exists only so a client that never cancels cannot leave a call pending
 * forever, so it sits far above the longest legitimate app-side operation (a secret card
 * waiting on a human) and never cuts a live call short.
 */
export const GATEWAY_BRIDGE_CALL_CAP_MS = 15 * 60 * 1000

/** Environment variable the bridge reads its call cap from. */
export const GATEWAY_BRIDGE_CALL_CAP_ENV = 'CODEINOVEN_UTILITY_BRIDGE_CALL_CAP_MS'

/** Turn identity the app-owned gateway utility needs; UtilityTurnRequest satisfies it. */
export interface GatewayTurnContext {
  harnessId: string
  projectId: string
  threadId: string
}

export const BROWSER_UTILITY_TOOLS: McpTool[] = [
  {
    name: 'open',
    description:
      'Open an http(s) URL in a browser tab owned by this project and thread. The tab is mounted offscreen at a real viewport, so the page loads, runs and can be read even while the user views another project or thread. Pass attention "background" to keep it offscreen without pulling the user to it.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        attention: {
          type: 'string',
          enum: ['focus', 'background'],
          description:
            'focus (default) shows the tab to the user when they are already in this thread; background never interrupts them.'
        }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'viewport',
    description:
      'Set the viewport this thread browser tab is laid out at while it runs offscreen, for checking responsive layouts. Give a preset or explicit width and height. A tab the user is currently viewing keeps the on-screen size and uses this viewport once it is offscreen again.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          enum: ['phone', 'phone-large', 'tablet', 'laptop', 'desktop']
        },
        width: { type: 'number' },
        height: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'snapshot',
    description:
      'Read the current thread browser page title, URL, visible text, and interactive elements.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'click',
    description: 'Click the first page element matching a CSS selector.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description: 'Replace an input, textarea, or editable element value and emit input/change.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, text: { type: 'string' } },
      required: ['selector', 'text'],
      additionalProperties: false
    }
  },
  {
    name: 'navigate',
    description: 'Navigate the current in-app browser tab to an http(s) URL.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture the browser page as a PNG data URL at its current viewport, whether the tab is on screen or parked offscreen.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'reload',
    description: 'Reload the current page.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'console',
    description:
      'Read console messages and browser runtime errors from the current project and thread tab.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  }
]

/**
 * Operations of the app-owned design capability (`cio:design`).
 *
 * One operation, because showing the design is the only thing the app has to do
 * that the agent cannot do with its own tools. Looking at the result is
 * deliberately not repeated here: the browser capability already owns
 * screenshots, viewports and console reads, and the docs point at it.
 */
export const DESIGN_UTILITY_TOOLS: McpTool[] = [
  {
    name: 'preview',
    description: `Serve a project folder on the app's own loopback origin and open it in this project and thread's browser tab. The folder's own scripts and stylesheets run, so an HTML design renders as written, and the tab is mounted offscreen at a real viewport whether or not the user is looking at it. Aim it at the folder holding the design's entry file.`,
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: `Project-relative folder to serve. Defaults to ${DESIGN_OUTPUT_ROOT}.`
        },
        entry: {
          type: 'string',
          description:
            'File inside that folder to load, relative to it. Defaults to index.html when that file exists; otherwise the folder listing is shown.'
        },
        attention: {
          type: 'string',
          enum: ['focus', 'background'],
          description:
            'focus (default) shows the tab to the user when they are already in this thread; background never interrupts them.'
        }
      },
      additionalProperties: false
    }
  }
]

export function gatewayUtility(
  request: GatewayTurnContext,
  scriptPath: string,
  bridgeUrl: string,
  token: string
): ResolvedUtility {
  const now = Date.now()
  const utility: UtilityDefinitionFor<'mcp'> = {
    id: `${GATEWAY_UTILITY_ID_PREFIX}${request.threadId}`,
    kind: 'mcp',
    name: 'CodeInOven utilities',
    description: 'Search, activate, and invoke scoped app-owned utilities on demand.',
    enabled: true,
    activation: 'always',
    scope: { level: 'thread', projectId: request.projectId, threadId: request.threadId },
    config: {
      transport: 'stdio',
      command: process.execPath,
      args: [scriptPath],
      environment: {
        ELECTRON_RUN_AS_NODE: '1',
        CODEINOVEN_UTILITY_BRIDGE_URL: bridgeUrl,
        CODEINOVEN_UTILITY_BRIDGE_TOKEN: token,
        [GATEWAY_BRIDGE_CALL_CAP_ENV]: String(GATEWAY_BRIDGE_CALL_CAP_MS)
      }
    },
    credentials: [],
    harnessBindings: [
      { harnessId: request.harnessId, strategy: 'mcp', transportName: 'utilities' }
    ],
    appOwned: false,
    createdAt: now,
    updatedAt: now
  }
  const binding: HarnessUtilityBinding = utility.harnessBindings[0]!
  return { utility, binding }
}

/** Build the stdio MCP gateway script. The tool list and the tools/call route
 *  map are generated from `GATEWAY_TOOLS`, so the agent-facing contract always
 *  matches the catalog   no hand-synchronized copy to drift.
 *
 *  Calls run concurrently. One bridge process serves every call the harness makes to
 *  `cio_util_*`, across the sessions that share it, so a single slow call (a secret card
 *  waiting on a human, a long browser or computer-use operation) must never queue the calls
 *  behind it. Each call answers on its own by JSON-RPC id, and a client cancellation aborts
 *  exactly the call it names. */
export function buildUtilityGatewayScript(gatewayTools = GATEWAY_TOOLS): string {
  const tools = gatewayTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }))
  const routes: Record<string, string> = {}
  for (const tool of gatewayTools) routes[tool.name] = tool.route
  const callCapMs = GATEWAY_BRIDGE_CALL_CAP_MS
  const callCapEnv = GATEWAY_BRIDGE_CALL_CAP_ENV
  return String.raw`import readline from 'node:readline'

const baseUrl = process.env.CODEINOVEN_UTILITY_BRIDGE_URL
const token = process.env.CODEINOVEN_UTILITY_BRIDGE_TOKEN
const configuredCapMs = Number(process.env.${callCapEnv})
const callCapMs =
  Number.isFinite(configuredCapMs) && configuredCapMs > 0 ? configuredCapMs : ${callCapMs}
const tools = ${JSON.stringify(tools)}
const routes = ${JSON.stringify(routes)}

// One live call per JSON-RPC id, so a cancellation aborts exactly the call it names.
// Cancelled ids are remembered so the bridge never answers a call the client has
// already stopped waiting for.
const inFlight = new Map()
const cancelled = new Set()

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function failureMessage(error, controller) {
  if (controller.signal.aborted) {
    const reason = controller.signal.reason
    if (reason instanceof Error) return reason.message
    if (typeof reason === 'string' && reason) return reason
    return 'Utility gateway call was cancelled'
  }
  return error instanceof Error ? error.message : 'Gateway failure'
}

/** A secret result can carry collected values out of band for an in-process gateway
 *  transport. No MCP transport may forward them, so the reserved field is dropped here,
 *  before the tool result reaches the harness. */
function resultContent(result) {
  if (result && typeof result === 'object' && 'environment' in result) {
    delete result.environment
  }
  return Array.isArray(result?.content)
    ? result.content
    : [{ type: 'text', text: JSON.stringify(result) }]
}

async function callUtility(request, controller) {
  if (!baseUrl || !token) throw new Error('Utility bridge environment is unavailable')
  const name = request.params?.name
  const args = request.params?.arguments || {}
  const path = routes[name]
  if (!path) throw new Error('Unknown utility gateway tool')
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(args),
    signal: controller.signal
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Utility bridge call failed')
  return body
}

async function respondToCall(request) {
  const id = request.id
  const key = String(id)
  const controller = new AbortController()
  const cap = setTimeout(() => {
    controller.abort(new Error('Utility gateway call exceeded its ' + callCapMs + ' ms cap'))
  }, callCapMs)
  if (typeof cap.unref === 'function') cap.unref()
  inFlight.set(key, controller)
  try {
    const result = await callUtility(request, controller)
    if (cancelled.has(key)) return
    write({ jsonrpc: '2.0', id: id, result: { content: resultContent(result) } })
  } catch (error) {
    if (cancelled.has(key)) return
    write({
      jsonrpc: '2.0',
      id: id,
      error: { code: -32000, message: failureMessage(error, controller) }
    })
  } finally {
    clearTimeout(cap)
    inFlight.delete(key)
    cancelled.delete(key)
  }
}

/** Abort one in-flight call. The response is suppressed, because the client that sent
 *  the cancellation has already stopped waiting for it. */
function cancelCall(params) {
  const key = String(params?.requestId)
  const controller = inFlight.get(key)
  if (!controller) return
  cancelled.add(key)
  controller.abort(
    new Error('Cancelled by the client: ' + (params?.reason || 'no reason given'))
  )
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
  } catch {
    continue
  }
  if (request.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'codeinoven-utilities', version: '1' }
      }
    })
    continue
  }
  if (request.method === 'tools/list') {
    write({ jsonrpc: '2.0', id: request.id, result: { tools: tools } })
    continue
  }
  if (request.method === 'ping') {
    write({ jsonrpc: '2.0', id: request.id, result: {} })
    continue
  }
  if (request.method === 'notifications/cancelled') {
    cancelCall(request.params)
    continue
  }
  if (request.method === 'tools/call') {
    // Deliberately not awaited: the loop must keep reading stdin so a slow call cannot
    // delay the calls behind it. respondToCall writes its own result or error.
    void respondToCall(request)
    continue
  }
  if (request.id !== undefined) {
    write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
  }
}
`
}

const MAX_CUA_SESSION_TITLE_CHARS = 24

/**
 * Build the Cua session id shown as the on-screen agent cursor label. The
 * turn id is always kept so session identity stays stable; the thread title
 * is prepended as a human-readable label (e.g. `cio-fix-pip-focus-a1b2c3`).
 */
export function buildCuaSessionId(threadTitle: string | undefined, turnId: string): string {
  const label = (threadTitle ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_CUA_SESSION_TITLE_CHARS)
    .replace(/-+$/gu, '')
  return label ? `cio-${label}-${turnId}` : `codeinoven-${turnId}`
}
