import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import {
  LEAN_AGENTS,
  LEAN_AGENT_NAMES,
  type LeanOpenCodeAgent
} from './opencode-agent-definitions'

/** Machine-wide opencode config the app merges lean agents into. */
export const OPENCODE_CONFIG_DIR = join(homedir(), '.config', 'opencode')
export const OPENCODE_CONFIG_PATH = join(OPENCODE_CONFIG_DIR, 'opencode.json')

/** Byte-exact pre-merge backup kept alongside the config so rollback restores
 *  the previous state file-for-file. */
const ROLLBACK_BACKUP_PATH = (configPath: string): string =>
  join(dirname(configPath), '.opencode.json.cio-agents-backup')

export interface OpenCodeGlobalConfigMergeOptions {
  /** Override the global config path (tests + rollback tooling). */
  configPath?: string
  /** Override the backup path where the pre-merge file is preserved. */
  backupPath?: string
  /** Override the shipped agent set (tests pin a fixture). */
  agents?: readonly LeanOpenCodeAgent[]
}

export interface MergeLeanAgentsResult {
  /** Agent names now present in the config (idempotently applied). */
  applied: string[]
  /** Agent names skipped because a user-owned entry already occupies them. */
  skipped: string[]
  /** Whether the config file contents changed (needs a write). */
  changed: boolean
  /** Set when the merge refused to touch a config (JSONC/non-JSON). */
  skippedFile: boolean
  warning?: string
  /** Path of the preserved pre-merge backup, when a rewrite happened. */
  backupPath?: string
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) {
    return false
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const leftEntries = Object.entries(left as Record<string, unknown>)
  const rightEntries = Object.entries(right as Record<string, unknown>)
  if (leftEntries.length !== rightEntries.length) return false
  return leftEntries.every(
    ([key, value]) =>
      key in (right as Record<string, unknown>) &&
      deepEqual(value, (right as Record<string, unknown>)[key])
  )
}

function formatConfig(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

function isPlainJson(raw: string): boolean {
  try {
    JSON.parse(raw)
    return true
  } catch {
    return false
  }
}

const skippedFile = (configPath: string, reason: string): MergeLeanAgentsResult => ({
  applied: [],
  skipped: [],
  changed: false,
  skippedFile: true,
  warning: `Cannot merge lean agents: ${configPath} ${reason}`
})

/**
 * Merge CodeInOven's lean agents into the machine-wide opencode config using
 * the same discipline as the provider-hiding merge: plain JSON only, additive,
 * idempotent, and never clobbering user-owned entries or other keys. JSONC
 * configs (comments/trailing commas) are skipped with a warning and never
 * rewritten. On a real content change the previous file is preserved
 * byte-for-byte in a backup for reversible rollback.
 */
export async function mergeLeanAgentsGlobalConfig(
  options: OpenCodeGlobalConfigMergeOptions = {}
): Promise<MergeLeanAgentsResult> {
  const configPath = options.configPath ?? OPENCODE_CONFIG_PATH
  const backupPath = options.backupPath ?? ROLLBACK_BACKUP_PATH(configPath)
  const agents = options.agents ?? LEAN_AGENTS

  let hadFile = true
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      hadFile = false
      raw = ''
    } else {
      throw error
    }
  }

  if (raw.trim().length > 0 && !isPlainJson(raw)) {
    return skippedFile(configPath, 'is not plain JSON. Add the "agent" entries manually.')
  }

  const config: Record<string, unknown> = raw.trim().length > 0 ? JSON.parse(raw) : {}
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return skippedFile(configPath, 'is not a JSON object.')
  }

  const existingAgent = config['agent']
  if (
    existingAgent !== undefined &&
    (existingAgent === null || typeof existingAgent !== 'object' || Array.isArray(existingAgent))
  ) {
    return skippedFile(configPath, 'has an "agent" field that is not an object.')
  }
  const agentMap = (existingAgent as Record<string, unknown> | undefined) ?? {}

  const applied: string[] = []
  const skipped: string[] = []
  const nextAgents: Record<string, unknown> = { ...agentMap }
  let changed = false

  for (const agent of agents) {
    const existing = nextAgents[agent.name]
    if (existing === undefined) {
      nextAgents[agent.name] = agent
      applied.push(agent.name)
      changed = true
    } else if (deepEqual(existing, agent)) {
      // Already merged and byte-compatible — idempotent no-op.
    } else {
      skipped.push(agent.name)
    }
  }

  if (changed) {
    await mkdir(dirname(configPath), { recursive: true })
    if (hadFile) {
      // Preserve the pre-merge file byte-for-byte BEFORE overwriting so the
      // documented rollback can restore it exactly.
      await writeFile(backupPath, raw, { encoding: 'utf8' })
    } else {
      await rm(backupPath, { force: true }).catch(() => undefined)
    }
    config['agent'] = nextAgents
    await writeFile(configPath, formatConfig(config), { encoding: 'utf8' })
  }

  return {
    applied,
    skipped,
    changed,
    skippedFile: false,
    ...(changed && hadFile ? { backupPath } : {})
  }
}

/**
 * Revert a merged lean-agents change. If a pre-merge backup exists it is
 * restored byte-for-byte; otherwise every CodeInOven agent entry is removed
 * from the current config. Returns whether a rewrite happened.
 */
export async function rollbackLeanAgentsGlobalConfig(
  options: OpenCodeGlobalConfigMergeOptions = {}
): Promise<boolean> {
  const configPath = options.configPath ?? OPENCODE_CONFIG_PATH
  const backupPath = options.backupPath ?? ROLLBACK_BACKUP_PATH(configPath)
  try {
    const backup = await readFile(backupPath, 'utf8')
    await writeFile(configPath, backup, { encoding: 'utf8' })
    await rm(backupPath, { force: true })
    return true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  // No backup: remove only our app-managed names, preserving everything else.
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
  if (!isPlainJson(raw)) return false
  const config = JSON.parse(raw) as Record<string, unknown>
  const agentMap =
    config['agent'] !== null &&
    typeof config['agent'] === 'object' &&
    !Array.isArray(config['agent'])
      ? (config['agent'] as Record<string, unknown>)
      : {}
  const names = new Set((options.agents ?? LEAN_AGENTS).map((agent) => agent.name))
  let changed = false
  for (const name of names) {
    if (name in agentMap) {
      delete agentMap[name]
      changed = true
    }
  }
  if (changed) {
    if (Object.keys(agentMap).length === 0) delete config['agent']
    else config['agent'] = agentMap
    await writeFile(configPath, formatConfig(config), { encoding: 'utf8' })
  }
  return changed
}

/**
 * Compatibility alias for the earlier single-path API. Kept so the provider
 * dashboard / docs can use it without threading an options object.
 */
export const rollbackMergedAgents: typeof rollbackLeanAgentsGlobalConfig =
  rollbackLeanAgentsGlobalConfig

/** Whether the machine-wide config still has the app plugin wiring intact.
 *  Returns true when the parse succeeds regardless of agent contents. */
export async function globalConfigHasPluginWiring(
  configPath = OPENCODE_CONFIG_PATH
): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    return false
  }
  if (!isPlainJson(raw)) return false
  const config = JSON.parse(raw) as Record<string, unknown>
  return Array.isArray(config['plugin']) && config['plugin'].includes('@sveltejs/opencode')
}

/** Convenience re-export so consumers can resolve agent names from one place. */
export { LEAN_AGENT_NAMES }
