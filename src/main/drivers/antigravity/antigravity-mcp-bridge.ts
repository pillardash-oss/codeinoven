import { existsSync } from 'node:fs'
import { copyFile, link, lstat, mkdir, readFile, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { McpUtilityConfig, ResolvedUtility } from '../../../lib/types/utility'
import {
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME
} from '../../../lib/gateway-tools'
import { Logger } from '../../system/logger'

/**
 * Antigravity CLI's MCP bridge.
 *
 * `agy` exposes no per-launch MCP configuration: its servers live in one global
 * file, `$HOME/.gemini/config/mcp_config.json`, and `agy mcp add` writes exactly
 * that file. Writing the user's own config once per turn would leave a dead
 * gateway behind after any crash and let two concurrent turns clobber each
 * other, so a turn gets its own HOME instead. The CLI profile directory is linked
 * through (that is where authentication, conversations and brain transcripts
 * live), and the turn's generated `mcp_config.json` is the only file the overlay
 * owns, so everything except MCP behaves exactly as a normal launch.
 */

/** MCP server key the app utility gateway is registered under for a turn. */
export const ANTIGRAVITY_GATEWAY_SERVER_KEY = 'utilities'

/** The turn's HOME directory, relative to the utility runtime directory. */
export const ANTIGRAVITY_SESSION_HOME = 'antigravity/home'

/** The turn's generated MCP config, relative to the utility runtime directory. */
export const ANTIGRAVITY_MCP_CONFIG_PATH = `${ANTIGRAVITY_SESSION_HOME}/.gemini/config/mcp_config.json`

/** The meta-tool `agy` routes every MCP tool call through. */
const CALL_MCP_TOOL_NAME = 'call_mcp_tool'

/** One `mcpServers` entry in Antigravity's documented config schema. */
export type AntigravityMcpServer = Record<string, unknown>

/**
 * Key one server is registered under. Antigravity shows this name to the model,
 * so it is the identifier the routing note quotes; the sanitizer matches the one
 * Claude Code and Cline use for the same purpose.
 */
function mcpServerKey(value: string): string {
  const key = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  return key || 'utility'
}

/** Map one app utility onto Antigravity's documented server entry. */
function mcpServerEntry(
  config: McpUtilityConfig,
  utilityName: string
): AntigravityMcpServer | null {
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new TypeError(`Antigravity MCP utility "${utilityName}" requires a command`)
    }
    return {
      command: config.command,
      args: [...(config.args ?? [])],
      env: { ...(config.environment ?? {}) },
      disabled: false
    }
  }
  // Antigravity speaks Streamable HTTP only and its config parser rejects the
  // legacy HTTP+SSE transport. Such a utility is not registered natively; it
  // stays reachable through the gateway, which proxies the call itself.
  if (config.transport === 'sse') {
    Logger.dev(`Antigravity cannot register the SSE MCP utility "${utilityName}" natively`)
    return null
  }
  if (!config.url) {
    throw new TypeError(`Antigravity MCP utility "${utilityName}" requires a URL`)
  }
  return {
    url: config.url,
    ...(config.headers ? { headers: { ...config.headers } } : {}),
    disabled: false
  }
}

/**
 * Every MCP utility this turn resolved, keyed for Antigravity. The app gateway
 * arrives in the same list, so its key is reported back for the routing note.
 */
export function antigravityMcpServers(resolvedUtilities: ResolvedUtility[]): {
  servers: Record<string, AntigravityMcpServer>
  gatewayKey: string | null
} {
  const servers: Record<string, AntigravityMcpServer> = {}
  const keys = new Set<string>()
  let gatewayKey: string | null = null
  for (const { utility, binding } of resolvedUtilities) {
    if (utility.kind !== 'mcp') continue
    const baseKey = mcpServerKey(binding.transportName ?? utility.name)
    let key = baseKey
    for (let suffix = 2; keys.has(key); suffix += 1) key = `${baseKey}-${suffix}`
    keys.add(key)
    const entry = mcpServerEntry(utility.config, utility.name)
    if (!entry) continue
    servers[key] = entry
    // The gateway utility is the only one the app itself generates for the turn;
    // it is registered under the transport name `utilities`.
    if (binding.transportName === ANTIGRAVITY_GATEWAY_SERVER_KEY) gatewayKey = key
  }
  return { servers, gatewayKey }
}

/**
 * The user's own MCP servers, read from the config this turn's HOME shadows.
 * A turn must not take away the servers the user configured for their own
 * Antigravity sessions, so they are carried into the generated file.
 */
export async function readAntigravityGlobalMcpServers(
  home: string
): Promise<Record<string, AntigravityMcpServer>> {
  const path = join(home, '.gemini', 'config', 'mcp_config.json')
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const servers = (parsed as { mcpServers?: unknown }).mcpServers
    if (servers === null || typeof servers !== 'object') return {}
    const entries: Record<string, AntigravityMcpServer> = {}
    for (const [key, value] of Object.entries(servers)) {
      if (value !== null && typeof value === 'object') {
        entries[key] = value as AntigravityMcpServer
      }
    }
    return entries
  } catch {
    // A missing or unreadable global config simply means the user has none.
    return {}
  }
}

/** Whether a path is already occupied, including by a dangling symlink. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Link `target` at `linkPath` without requiring elevation. Windows cannot create
 * a plain symlink unprivileged, so directories become junctions and files fall
 * back to a hard link and then a copy.
 */
async function linkInto(
  target: string,
  linkPath: string,
  kind: 'file' | 'dir'
): Promise<void> {
  if (!existsSync(target) || (await pathExists(linkPath))) return
  await mkdir(dirname(linkPath), { recursive: true })
  try {
    if (process.platform !== 'win32') {
      await symlink(target, linkPath, kind)
      return
    }
    if (kind === 'dir') {
      await symlink(target, linkPath, 'junction')
      return
    }
    await link(target, linkPath).catch(() => copyFile(target, linkPath))
  } catch (error) {
    Logger.dev(`Antigravity profile could not be linked at ${linkPath}:`, error)
  }
}

/**
 * Build the turn's HOME: the CLI profile and the non-MCP parts of the global
 * config are linked through from the real home, so the only thing the turn
 * overrides is its own `mcp_config.json`.
 */
export async function linkAntigravityProfile(
  sessionHome: string,
  realHome: string
): Promise<void> {
  const gemini = join(sessionHome, '.gemini')
  await mkdir(join(gemini, 'config'), { recursive: true })
  const realGemini = join(realHome, '.gemini')
  await linkInto(join(realGemini, 'antigravity-cli'), join(gemini, 'antigravity-cli'), 'dir')
  await linkInto(join(realGemini, 'config', 'config.json'), join(gemini, 'config', 'config.json'), 'file')
  await linkInto(join(realGemini, 'config', 'projects'), join(gemini, 'config', 'projects'), 'dir')
}

/**
 * Antigravity lists MCP tools in the session's tool surface but routes every
 * call through its own meta-tool, so the gateway instructions have to name the
 * route. Without this the agent is told to call `cio_util_find` and finds no
 * such tool.
 */
export function antigravityGatewayRoutingNote(gatewayKey: string): string {
  return `Antigravity reaches MCP tools through its own \`${CALL_MCP_TOOL_NAME}\` meta-tool rather than exposing them as top-level tools. The app utility gateway is the MCP server "${gatewayKey}", so call \`${UTILITY_SEARCH_TOOL_NAME}\`, \`${UTILITY_ACTIVATE_TOOL_NAME}\` and \`${UTILITY_INVOKE_TOOL_NAME}\` through it: \`${CALL_MCP_TOOL_NAME}\` with {"ServerName":"${gatewayKey}","ToolName":"<gateway tool name>","Arguments":{...}}. Their schemas are listed with this session's MCP tools.`
}
