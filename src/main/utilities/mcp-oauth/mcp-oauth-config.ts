import type { McpOAuthAuthorizeRequest, McpOAuthConfig } from '../../../lib/types'

/**
 * Field names a stored MCP OAuth config may carry.
 *
 * No name here may read as a secret: the registry refuses to persist a config
 * key that matches a credential-shaped name, which is what keeps a token from
 * ever being written into a utility definition. That is also why the client type
 * is stored as `confidentialClient` rather than as any key containing "secret".
 */
const MCP_OAUTH_KEYS = new Set([
  'enabled',
  'issuer',
  'clientId',
  'confidentialClient',
  'scope',
  'resource',
  'expiresAt',
  'authorizedAt'
])

/**
 * Normalize the OAuth block of an MCP config.
 *
 * Shared by the registry and the connection-test boundary so a configuration
 * that saves is exactly a configuration that can be tested. The shape is
 * strict: every field here is written by the app, so an unknown one is a bug
 * rather than a user choice.
 */
export function parseMcpOAuthConfig(value: unknown): McpOAuthConfig {
  const record = plainRecord(value)
  const keys = Object.keys(record)
  for (const key of keys) {
    if (!MCP_OAUTH_KEYS.has(key)) {
      throw new TypeError(`MCP OAuth config field "${key}" is not supported`)
    }
  }
  const enabled = record['enabled']
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new TypeError('MCP OAuth enabled must be a boolean')
  }
  const confidentialClient = record['confidentialClient']
  if (confidentialClient !== undefined && typeof confidentialClient !== 'boolean') {
    throw new TypeError('MCP OAuth client type must be a boolean')
  }
  return {
    enabled: enabled !== false,
    ...optional('issuer', record['issuer'], 2_000),
    ...optional('clientId', record['clientId'], 512),
    ...(confidentialClient === undefined ? {} : { confidentialClient }),
    ...optional('scope', record['scope'], 4_000),
    ...optional('resource', record['resource'], 2_000),
    ...timestamp('expiresAt', record['expiresAt']),
    ...timestamp('authorizedAt', record['authorizedAt'])
  }
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('MCP OAuth config must be an object')
  }
  return value as Record<string, unknown>
}

function optional<Key extends keyof McpOAuthConfig>(
  key: Key,
  value: unknown,
  maxLength: number
): Pick<McpOAuthConfig, Key> | Record<string, never> {
  if (value === undefined) return {}
  if (typeof value !== 'string') throw new TypeError(`MCP OAuth ${key} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    throw new TypeError(`MCP OAuth ${key} must be between 1 and ${maxLength} characters`)
  }
  return { [key]: trimmed } as Pick<McpOAuthConfig, Key>
}

function timestamp<Key extends 'expiresAt' | 'authorizedAt'>(
  key: Key,
  value: unknown
): Pick<McpOAuthConfig, Key> | Record<string, never> {
  if (value === undefined) return {}
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`MCP OAuth ${key} must be a timestamp`)
  }
  return { [key]: Math.trunc(value) } as Pick<McpOAuthConfig, Key>
}

/**
 * Normalize what an interactive authorization was asked to do.
 *
 * The one place a client secret crosses into main. It is transient input to a
 * flow and is stored in the credential vault, never in the utility config, so
 * this request is validated here rather than by the config parser.
 */
export function parseMcpOAuthAuthorizeRequest(value: unknown): McpOAuthAuthorizeRequest {
  if (value === undefined) return {}
  const record = plainRecord(value)
  for (const key of Object.keys(record)) {
    if (key !== 'clientId' && key !== 'clientSecret' && key !== 'scope') {
      throw new TypeError(`MCP OAuth authorize field "${key}" is not supported`)
    }
  }
  const clientSecret = record['clientSecret']
  if (clientSecret !== undefined && typeof clientSecret !== 'string') {
    throw new TypeError('MCP OAuth client secret must be a string')
  }
  return {
    ...optional('clientId', record['clientId'], 512),
    ...(clientSecret === undefined
      ? {}
      : { clientSecret: bounded(clientSecret, 'MCP OAuth client secret', 16_384) }),
    ...optional('scope', record['scope'], 4_000)
  }
}

function bounded(value: string, label: string, maxLength: number): string {
  if (value.includes('\0') || value.length > maxLength) {
    throw new TypeError(`${label} must be at most ${maxLength} characters`)
  }
  return value
}
