import type {
  HarnessUtilityBinding,
  ResolvedUtility,
  UtilityDefinitionFor
} from '../../../lib/types'
import { GATEWAY_TOOLS, RETRIEVE_MCP_HOST_TOOL_NAME } from '../../../lib/gateway-tools'
import type { McpTool } from '../../agents/mcp-stdio-client'

export const BRIDGE_SCRIPT_PATH = 'runtime/utility-gateway/bridge.mjs'
export const RETRIEVE_MCP_HOST_ROUTE = '/retrieve-mcp-host'
export const RETRIEVE_MCP_HOST_SCRIPT_PATH = `runtime/utility-gateway/${RETRIEVE_MCP_HOST_TOOL_NAME}.mjs`

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
 * The operation catalog for the app-owned Android target capability (`cio:adb`).
 *
 * Tool names are the operation names the service dispatches on, so the catalog
 * and the dispatch table are the same list. Node text is omitted by default
 * everywhere text can appear: the tree is user data, and the largest context
 * cost in this workflow.
 */
const ADB_SELECTOR_SCHEMA = {
  type: 'object',
  description: 'Node predicate. At least one field is required.',
  properties: {
    resourceId: {
      type: 'string',
      description: 'Android resource id, with or without the package prefix.'
    },
    contentDesc: {
      type: 'string',
      description: 'Exact accessibility label, which is where a React or Svelte aria-label lands.'
    },
    text: { type: 'string', description: 'Exact node text.' },
    textContains: { type: 'string', description: 'Case-insensitive substring of node text.' },
    className: {
      type: 'string',
      description: 'Full class name, or the short form such as EditText or Button.'
    },
    editable: { type: 'boolean' },
    clickable: { type: 'boolean' },
    focused: { type: 'boolean' },
    packageName: { type: 'string' }
  },
  additionalProperties: false
} as const

const ADB_TEXT_MODE_SCHEMA = {
  type: 'string',
  enum: ['omit', 'length', 'include'],
  description:
    'How much node text to return. "omit" is the default; use "include" only when the text itself is the point.'
} as const

export const ADB_UTILITY_TOOLS: McpTool[] = [
  {
    name: 'targets',
    description:
      'List attached Android phones and emulators with serial, state, model, sdk, size, density and whether a lease is held. Start here.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'claim',
    description:
      'Take the exclusive lease on one target so no other session drives it while you work. Omit serial when exactly one target is attached.',
    inputSchema: {
      type: 'object',
      properties: {
        serial: { type: 'string' },
        ttlMinutes: {
          type: 'number',
          description: 'Hold length in minutes, 1 to 240. Default 15, refreshed by every operation.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'release',
    description: 'Drop the lease this session holds, so another session can use the target.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'status',
    description:
      'Screen state, foreground package and activity, keyboard visibility, size and density for the leased target. Run it before trusting any coordinate.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'dump',
    description:
      'Read the accessibility view tree. Reports native windows on top, retries while the tree is still filling in, and never uses compressed mode. Interactive nodes only by default, so it does not flood context.',
    inputSchema: {
      type: 'object',
      properties: {
        text: ADB_TEXT_MODE_SCHEMA,
        detail: {
          type: 'string',
          enum: ['interactive', 'full'],
          description: 'full includes bare layout containers.'
        },
        limit: { type: 'number', description: 'Node cap. Default 120, maximum 400.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'find',
    description:
      'Locate nodes by resource id, aria label, text or class, and return their bounds and tap centre.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: ADB_SELECTOR_SCHEMA,
        text: ADB_TEXT_MODE_SCHEMA,
        limit: { type: 'number', description: 'Match cap. Default 10, maximum 50.' }
      },
      required: ['selector'],
      additionalProperties: false
    }
  },
  {
    name: 'tap',
    description:
      'Tap a located node by selector, or explicit x and y coordinates. Taps a node centre, never a guessed pixel.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: ADB_SELECTOR_SCHEMA,
        x: { type: 'number' },
        y: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'type',
    description:
      'Type printable ASCII into the focused field, then read it back. Spaces are handled for you. Non-ASCII is refused and reported rather than silently dropped.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        clearFirst: { type: 'boolean', description: 'Backspace the field empty first.' },
        verify: { type: 'boolean', description: 'Read the field back and compare. Default true.' }
      },
      required: ['text'],
      additionalProperties: false
    }
  },
  {
    name: 'key',
    description: 'Press one key by name, such as BACK, HOME, ENTER or TAB, or by numeric keycode.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
      additionalProperties: false
    }
  },
  {
    name: 'start',
    description:
      'Launch a package by its launcher activity, an explicit component, or a deep link URL.',
    inputSchema: {
      type: 'object',
      properties: {
        package: { type: 'string' },
        component: { type: 'string' },
        url: { type: 'string' },
        waitForSelector: ADB_SELECTOR_SCHEMA,
        timeoutMs: { type: 'number' },
        pollMs: { type: 'number' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'screenshot',
    description:
      'Capture the screen as an image, downscaled by default. Use this when you need to know what is on screen rather than which nodes exist.',
    inputSchema: {
      type: 'object',
      properties: {
        maxWidth: {
          type: 'number',
          description: 'Downscale width in pixels. Default 720; pass 0 for the raw capture.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'wait_for',
    description:
      'Poll the tree until a selector is present or absent. Use it instead of sleeping, and never chain two taps without a read between them.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: ADB_SELECTOR_SCHEMA,
        state: { type: 'string', enum: ['present', 'absent'] },
        timeoutMs: { type: 'number', description: 'Default 10000, maximum 120000.' },
        pollMs: { type: 'number', description: 'Default 700.' }
      },
      required: ['selector'],
      additionalProperties: false
    }
  },
  {
    name: 'reconnect',
    description:
      'Recover a target that stopped answering: re-check the list, reconnect the transport, check the USB bus, then re-check.',
    inputSchema: {
      type: 'object',
      properties: { serial: { type: 'string' } },
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
    id: `cio:utility-gateway:${request.threadId}`,
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
        CODEINOVEN_UTILITY_BRIDGE_TOKEN: token
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
 *  matches the catalog   no hand-synchronized copy to drift. */
export function buildUtilityGatewayScript(gatewayTools = GATEWAY_TOOLS): string {
  const tools = gatewayTools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema
  }))
  const routes: Record<string, string> = {}
  for (const tool of gatewayTools) routes[tool.name] = tool.route
  return String.raw`import readline from 'node:readline'

const baseUrl = process.env.CODEINOVEN_UTILITY_BRIDGE_URL
const token = process.env.CODEINOVEN_UTILITY_BRIDGE_TOKEN
const tools = ${JSON.stringify(tools)}
const routes = ${JSON.stringify(routes)}

async function bridge(path, args) {
  if (!baseUrl || !token) throw new Error('Utility bridge environment is unavailable')
  const response = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(args)
  })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Utility bridge call failed')
  return body
}

function write(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  let request
  try {
    request = JSON.parse(line)
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
    } else if (request.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: request.id, result: { tools } })
    } else if (request.method === 'tools/call') {
      const name = request.params?.name
      const args = request.params?.arguments || {}
      const path = routes[name]
      if (!path) throw new Error('Unknown utility gateway tool')
      const result = await bridge(path, args)
      // A secret result can carry collected values out of band for an in-process
      // gateway transport. No MCP transport may forward them, so the reserved
      // field is dropped here, before the tool result reaches the harness.
      if (result && typeof result === 'object' && 'environment' in result) {
        delete result.environment
      }
      const content = Array.isArray(result?.content)
        ? result.content
        : [{ type: 'text', text: JSON.stringify(result) }]
      write({ jsonrpc: '2.0', id: request.id, result: { content } })
    } else if (request.id !== undefined) {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })
    }
  } catch (error) {
    if (request?.id !== undefined) {
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : 'Gateway failure' } })
    }
  }
}
`
}

/**
 * Build the durable, shell-callable host resolver. It reads only public process
 * metadata and probes every loopback gateway in parallel; bearer credentials
 * never enter the registry, command arguments, or tool output.
 */
export function buildMcpHostRetrieverScript(instanceDirectory: string): string {
  return String.raw`import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const instanceDirectory = ${JSON.stringify(instanceDirectory)}
const sessionId = process.argv[2]?.trim()
const turnId = process.argv[3]?.trim()

if (!sessionId || sessionId.length > 128 || (turnId !== undefined && turnId.length > 128)) {
  process.stderr.write(
    '${RETRIEVE_MCP_HOST_TOOL_NAME} requires the utility session id (and optionally the turn id).\n'
  )
  process.exit(1)
}

function validLoopbackHost(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? url.origin : null
  } catch {
    return null
  }
}

async function registeredHosts() {
  let files
  try {
    files = await fs.readdir(instanceDirectory)
  } catch {
    return []
  }
  const entries = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => {
        try {
          return JSON.parse(await fs.readFile(join(instanceDirectory, file), 'utf8'))
        } catch {
          return null
        }
      })
  )
  const newestAllowedHeartbeat = Date.now() - 120_000
  return [
    ...new Set(
      entries
        .filter(
          (entry) =>
            typeof entry?.lastHeartbeat === 'number' &&
            entry.lastHeartbeat >= newestAllowedHeartbeat
        )
        .map((entry) => validLoopbackHost(entry.mcpHost))
        .filter(Boolean)
    )
  ]
}

async function resolveHost(host) {
  try {
    const response = await fetch(host + ${JSON.stringify(RETRIEVE_MCP_HOST_ROUTE)}, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(turnId ? { session_id: sessionId, turn_id: turnId } : { session_id: sessionId }),
      signal: AbortSignal.timeout(1500)
    })
    if (!response.ok) return null
    const body = await response.json()
    return validLoopbackHost(body?.mcpHost)
  } catch {
    return null
  }
}

const hosts = await registeredHosts()
let resolved = null
try {
  resolved = await Promise.any(
    hosts.map(async (host) => {
      const candidate = await resolveHost(host)
      if (!candidate) throw new Error('Not the owning instance')
      return candidate
    })
  )
} catch {
  // No registered live instance owns this session.
}
if (!resolved) {
  process.stderr.write('No live CodeInOven instance owns this utility session.\n')
  process.exitCode = 1
} else {
  process.stdout.write(JSON.stringify({ mcpHost: resolved }) + '\n')
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
