import type { StorageEngine } from '../../storage/storage-engine'
import type { AcpAgentConfigInput, AcpAgentStatus } from '../../../lib/acp'
import { resolveExecutablePathAsync } from '../cli-environment'

/**
 * The user's own ACP agent: any harness binary that speaks the Agent Client
 * Protocol. CodeInOven ships no knowledge of it beyond the command it is
 * started with, which is exactly what makes "bring your own harness" work.
 */
export interface AcpAgentConfig {
  /** Display name shown in the harness picker. Defaults to "ACP agent". */
  name: string
  /** Executable to start, resolved like any other harness command. */
  command: string
  /** Arguments that put the harness into ACP mode, e.g. `['--acp']`. */
  args: string[]
  /** Extra environment variables the agent needs. */
  env: Record<string, string>
}

export const DEFAULT_ACP_AGENT_NAME = 'ACP agent'
const CONFIG_PATH = 'drivers/acp/agent.json'
const MAX_COMMAND_LENGTH = 512
const MAX_ARG_COUNT = 32
const MAX_ARG_LENGTH = 2048
const MAX_ENV_ENTRIES = 32
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/**
 * Harnesses verified to expose ACP, offered as starting points in the settings
 * form. Only commands that actually start an ACP server belong here; the fields
 * accept any command, which is the point of a generic ACP harness.
 */
export const KNOWN_ACP_AGENTS: readonly { name: string; command: string; args: string[] }[] = [
  { name: 'Cline', command: 'cline', args: ['--acp'] },
  // Cursor Agent ships ACP as a hidden `acp` subcommand (verified with
  // cursor-agent 2026.09.10: initialize, session/new with its model list, and
  // tool permissions all round-trip).
  { name: 'Cursor agent', command: 'cursor-agent', args: ['acp'] }
]

/** Normalize and validate a config patch. Throws on anything the app cannot launch. */
export function normalizeAcpAgentConfig(
  input: AcpAgentConfigInput,
  previous: AcpAgentConfig | null
): AcpAgentConfig {
  const command = (input.command ?? previous?.command ?? '').trim()
  if (command.length === 0) throw new Error('An ACP agent command is required')
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('The ACP agent command is too long')
  if (command.includes('\0')) throw new Error('The ACP agent command contains an invalid character')

  const rawArgs = input.args ?? previous?.args ?? []
  if (rawArgs.length > MAX_ARG_COUNT) throw new Error('Too many ACP agent arguments')
  const args = rawArgs.map((arg) => arg.trim()).filter((arg) => arg.length > 0)
  for (const arg of args) {
    if (arg.length > MAX_ARG_LENGTH) throw new Error('An ACP agent argument is too long')
    if (arg.includes('\0')) throw new Error('An ACP agent argument contains an invalid character')
  }

  const rawEnv = input.env ?? previous?.env ?? {}
  const entries = Object.entries(rawEnv)
  if (entries.length > MAX_ENV_ENTRIES) throw new Error('Too many ACP agent environment variables')
  const env: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) throw new Error(`"${key}" is not a valid environment variable name`)
    env[key] = value
  }

  const name = (input.name ?? previous?.name ?? DEFAULT_ACP_AGENT_NAME).trim()
  return {
    name: name.length > 0 ? name : DEFAULT_ACP_AGENT_NAME,
    command,
    args,
    env
  }
}

/**
 * Reads and writes the configured ACP agent.
 *
 * One app-wide instance: both the availability gates (which ask synchronously
 * whether an ACP harness is configured) and the Harnesses page must see the
 * same value, so the cache lives here rather than in each caller.
 */
export class AcpAgentConfigService {
  private cached: AcpAgentConfig | null | undefined
  private loading: Promise<AcpAgentConfig | null> | null = null

  constructor(private readonly storage: StorageEngine) {}

  /** The config as last loaded, for synchronous gates. Undefined until loaded. */
  get snapshot(): AcpAgentConfig | null | undefined {
    return this.cached
  }

  async load(): Promise<AcpAgentConfig | null> {
    if (this.cached !== undefined) return this.cached
    this.loading ??= this.read()
    const value = await this.loading
    this.loading = null
    this.cached = value
    return value
  }

  async save(input: AcpAgentConfigInput): Promise<AcpAgentConfig> {
    const previous = await this.load()
    const config = normalizeAcpAgentConfig(input, previous)
    await this.storage.write(CONFIG_PATH, config)
    this.cached = config
    return config
  }

  async status(): Promise<AcpAgentStatus> {
    const config = await this.load()
    if (!config) {
      return {
        configured: false,
        name: DEFAULT_ACP_AGENT_NAME,
        command: '',
        args: [],
        detail:
          'No ACP agent is configured yet. Add the command that starts your harness in ACP mode.'
      }
    }
    const resolvedPath = await resolveExecutablePathAsync(config.command)
    return {
      configured: true,
      name: config.name,
      command: config.command,
      args: [...config.args],
      ...(resolvedPath ? { resolvedPath } : {}),
      ...(resolvedPath ? {} : { detail: `"${config.command}" was not found on PATH.` })
    }
  }

  private async read(): Promise<AcpAgentConfig | null> {
    const raw = await this.storage.read(CONFIG_PATH).catch(() => null)
    if (!raw) return null
    try {
      return normalizeAcpAgentConfig(raw, null)
    } catch {
      return null
    }
  }
}

let sharedService: AcpAgentConfigService | null = null

/**
 * The app-wide ACP config service, created on first use for this data root.
 *
 * One instance serves both the Harnesses page and the availability gates, so a
 * command saved there is what the next turn and the model picker both see.
 */
export function acpAgentConfigService(storage: StorageEngine): AcpAgentConfigService {
  sharedService ??= new AcpAgentConfigService(storage)
  return sharedService
}

/** Synchronous read of the loaded config; callers fall back to `load()` when unset. */
export function currentAcpAgentConfig(): AcpAgentConfig | null {
  return sharedService?.snapshot ?? null
}

/**
 * Make sure the configured agent is in memory before a synchronous gate reads
 * it. A no-op when nothing has registered a config service yet, which keeps
 * pure modules usable in tests without app storage.
 */
export async function ensureAcpAgentConfigLoaded(): Promise<AcpAgentConfig | null> {
  return sharedService ? sharedService.load() : null
}
