import type {
  AgentCapabilitySource,
  McpProbeCredential,
  McpProbeTarget,
  McpUtilityConfig
} from '../../lib/types'
import {
  assertEnum,
  assertRecord,
  rejectUnknownFields,
  validateBoundedString,
  validateEntityId
} from '../ipc/validation/primitives'

/** Longest command, argument, URL, or header value a test may be asked to run. */
const MAX_CONNECTION_FIELD_LENGTH = 4_096

/** Most arguments, headers, or environment entries one MCP configuration may carry. */
const MAX_CONNECTION_ENTRIES = 200

const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const
const NATIVE_MCP_FORMATS = ['opencode', 'mcpServers', 'codex-toml'] as const
const PROBE_KINDS = ['registry', 'native', 'inline'] as const

/**
 * Validate a renderer-supplied connection test request.
 *
 * A test spawns a process or opens a socket from a user configuration, so the
 * boundary is strict about shape and size and never lets an unknown field
 * through to a launcher.
 */
export function validateMcpProbeTarget(value: unknown): McpProbeTarget {
  const target = assertRecord(value, 'MCP test target')
  const kind = assertEnum(target['kind'], new Set(PROBE_KINDS), 'MCP test target kind')
  if (kind === 'registry') {
    rejectUnknownFields(target, new Set(['kind', 'utilityId']), 'MCP test target')
    return {
      kind,
      utilityId: validateEntityId(target['utilityId'], 'Utility ID', 256)
    }
  }
  if (kind === 'native') {
    rejectUnknownFields(target, new Set(['kind', 'source']), 'MCP test target')
    return { kind, source: validateNativeMcpSource(target['source']) }
  }
  rejectUnknownFields(
    target,
    new Set(['kind', 'config', 'baseUtilityId', 'credentials']),
    'MCP test target'
  )
  const baseUtilityId = target['baseUtilityId']
  return {
    kind,
    config: validateMcpConnectionConfig(target['config']),
    ...(baseUtilityId === undefined
      ? {}
      : { baseUtilityId: validateEntityId(baseUtilityId, 'Utility ID', 256) }),
    ...(target['credentials'] === undefined
      ? {}
      : { credentials: validateProbeCredentials(target['credentials']) })
  }
}

/** A discovered server on disk, which the app only reads and never rewrites for a test. */
function validateNativeMcpSource(value: unknown): AgentCapabilitySource {
  const source = assertRecord(value, 'MCP capability source')
  const kind = assertEnum(source['kind'], new Set(['mcp', 'skill'] as const), 'Capability kind')
  if (kind !== 'mcp') {
    throw new TypeError('Only an MCP server can be tested')
  }
  rejectUnknownFields(source, new Set(['kind', 'configPath', 'format', 'serverName']), 'MCP source')
  const configPath = validateBoundedString(
    source['configPath'],
    'MCP config path',
    1,
    MAX_CONNECTION_FIELD_LENGTH
  )
  if (configPath.includes('\0')) throw new TypeError('MCP config path is invalid')
  return {
    kind,
    configPath,
    format: assertEnum(source['format'], new Set(NATIVE_MCP_FORMATS), 'MCP config format'),
    serverName: validateBoundedString(source['serverName'], 'MCP server name', 1, 256)
  }
}

export function validateMcpConnectionConfig(value: unknown): McpUtilityConfig {
  const config = assertRecord(value, 'MCP connection config')
  rejectUnknownFields(
    config,
    new Set(['transport', 'command', 'args', 'url', 'environment', 'headers']),
    'MCP connection config'
  )
  const command = config['command']
  const url = config['url']
  return {
    transport: assertEnum(config['transport'], new Set(MCP_TRANSPORTS), 'MCP transport'),
    ...(command === undefined
      ? {}
      : {
          command: validateBoundedString(command, 'MCP command', 1, MAX_CONNECTION_FIELD_LENGTH)
        }),
    ...(config['args'] === undefined
      ? {}
      : { args: validateStringList(config['args'], 'MCP argument') }),
    ...(url === undefined
      ? {}
      : { url: validateBoundedString(url, 'MCP URL', 1, MAX_CONNECTION_FIELD_LENGTH) }),
    ...(config['environment'] === undefined
      ? {}
      : { environment: validateStringRecord(config['environment'], 'MCP environment') }),
    ...(config['headers'] === undefined
      ? {}
      : { headers: validateStringRecord(config['headers'], 'MCP header') })
  }
}

function validateProbeCredentials(value: unknown): McpProbeCredential[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new TypeError('MCP test credentials must be an array of at most 50 entries')
  }
  return value.map((entry, index) => {
    const credential = assertRecord(entry, `MCP test credential ${index}`)
    rejectUnknownFields(
      credential,
      new Set(['environmentVariable', 'value']),
      `MCP test credential ${index}`
    )
    const environmentVariable = validateBoundedString(
      credential['environmentVariable'],
      `MCP test credential ${index} variable`,
      1,
      160
    )
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(environmentVariable)) {
      throw new TypeError(`MCP test credential ${index} variable is invalid`)
    }
    const raw = credential['value']
    if (typeof raw !== 'string' || raw.length > 16_384 || raw.includes('\0')) {
      throw new TypeError(`MCP test credential ${index} value is invalid`)
    }
    return { environmentVariable, value: raw }
  })
}

function validateStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_CONNECTION_ENTRIES) {
    throw new TypeError(`${label}s must be an array of at most ${MAX_CONNECTION_ENTRIES} entries`)
  }
  return value.map((entry) => validateBoundedString(entry, label, 1, MAX_CONNECTION_FIELD_LENGTH))
}

function validateStringRecord(value: unknown, label: string): Record<string, string> {
  const record = assertRecord(value, `${label}s`)
  const entries = Object.entries(record)
  if (entries.length > MAX_CONNECTION_ENTRIES) {
    throw new TypeError(`${label}s must contain at most ${MAX_CONNECTION_ENTRIES} entries`)
  }
  const result: Record<string, string> = {}
  for (const [key, entry] of entries) {
    if (!key.trim() || key.length > 256 || key.includes('\0')) {
      throw new TypeError(`${label} name is invalid`)
    }
    // Values may be empty: an empty header or variable is a legal configuration.
    if (typeof entry !== 'string' || entry.length > MAX_CONNECTION_FIELD_LENGTH) {
      throw new TypeError(`${label} value is invalid`)
    }
    result[key] = entry
  }
  return result
}
