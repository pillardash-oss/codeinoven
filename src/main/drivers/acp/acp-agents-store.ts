import type { StorageEngine } from '../../storage/storage-engine'
import { resolveExecutablePathAsync } from '../cli-environment'
import {
  MAX_ACP_AGENT_ICON_BYTES,
  type AcpAgent,
  type AcpAgentInput,
  type AcpAgentStatus
} from '../../../lib/acp'
import { acpUpdateCommandFor } from './acp-update-recipes'

/**
 * The ACP agents the user added: names, commands and icons, persisted in app
 * storage.
 *
 * Nothing here installs anything. An agent exists because the user typed the
 * command that starts a harness they already have, which is what lets any ACP
 * client join the app without a driver of its own.
 */

/** Harness id prefix every ACP agent's id carries. */
export const ACP_AGENT_ID_PREFIX = 'acp-'
const STORE_PATH = 'drivers/acp/agents.json'
/** The single-agent config this replaced; imported once so nothing is lost. */
const LEGACY_CONFIG_PATH = 'drivers/acp/agent.json'
const MAX_NAME_LENGTH = 64
const MAX_COMMAND_LENGTH = 512
const MAX_ARG_COUNT = 32
const MAX_ARG_LENGTH = 2048
const MAX_ENV_ENTRIES = 32
const MAX_UPDATE_COMMAND_LENGTH = 512
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u
const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/u

/** Harnesses verified to expose ACP, offered as starting points in the editor. */
export const KNOWN_ACP_AGENTS: readonly {
  name: string
  command: string
  args: string[]
  updateCommand?: string
}[] = [
  // Verified with cline 3.0.61: `--update` is the CLI's own update flag.
  { name: 'Cline', command: 'cline', args: ['--acp'], updateCommand: 'cline --update' },
  // Cursor Agent ships ACP as a hidden `acp` subcommand (verified with
  // cursor-agent 2026.09.10: initialize, session/new with its model list, and
  // tool permissions all round-trip), and its CLI carries an `update` command.
  {
    name: 'Cursor agent',
    command: 'cursor-agent',
    args: ['acp'],
    updateCommand: 'cursor-agent update'
  }
]

interface StoredAgents {
  version: 1
  agents: AcpAgent[]
}

/** Case- and spacing-insensitive form of the name an agent is keyed by. */
export function agentNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, ' ')
}

/**
 * One agent per identity, keeping the most recently saved copy of each.
 *
 * Two records are the same agent when they share a name, and also when they
 * share the exact launch configuration: a list that already holds "Cursor" and
 * "Cursor agent" pointed at one `cursor-agent acp` is three copies of one agent,
 * not three agents. The newest record wins because it is the one the user last
 * finished editing, so it is the one that carries their icon and args.
 */
function keepOnePerName(agents: readonly AcpAgent[]): AcpAgent[] {
  const newestFirst = [...agents].sort(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  )
  const seenNames = new Set<string>()
  const seenLaunch = new Set<string>()
  const kept: AcpAgent[] = []
  for (const agent of newestFirst) {
    const nameKey = agentNameKey(agent.name)
    const launchKey = [agent.command, ...agent.args, ...Object.entries(agent.env).flat()].join(
      '\u0000'
    )
    if (seenNames.has(nameKey) || seenLaunch.has(launchKey)) continue
    seenNames.add(nameKey)
    seenLaunch.add(launchKey)
    kept.push(agent)
  }
  return kept.reverse()
}

/** Whether an id names an ACP agent this store owns. */
export function isAcpAgentId(id: string): boolean {
  return id.startsWith(ACP_AGENT_ID_PREFIX)
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40) || 'agent'
  )
}

function validateIcon(value: string | null | undefined, label: string): string | undefined {
  if (value === null || value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (!DATA_URL.test(trimmed)) throw new Error(`${label} must be an image file`)
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_ACP_AGENT_ICON_BYTES * 1.4) {
    throw new Error(`${label} is larger than 256 KiB`)
  }
  return trimmed
}

/**
 * Normalize one editor submission. Throws on anything the app cannot launch, so
 * a bad command never reaches storage and never appears as a harness.
 */
export function normalizeAcpAgent(
  input: AcpAgentInput,
  existing: AcpAgent | null,
  now: number
): AcpAgent {
  const name = input.name.trim()
  if (name.length === 0) throw new Error('An agent name is required')
  if (name.length > MAX_NAME_LENGTH) throw new Error('The agent name is too long')

  const command = input.command.trim()
  if (command.length === 0) throw new Error('The command that starts the agent is required')
  if (command.length > MAX_COMMAND_LENGTH) throw new Error('The agent command is too long')
  if (command.includes('\0')) throw new Error('The agent command contains an invalid character')

  const rawArgs = input.args ?? existing?.args ?? []
  if (rawArgs.length > MAX_ARG_COUNT) throw new Error('Too many agent arguments')
  const args = rawArgs.map((arg) => arg.trim()).filter((arg) => arg.length > 0)
  for (const arg of args) {
    if (arg.length > MAX_ARG_LENGTH) throw new Error('An agent argument is too long')
    if (arg.includes('\0')) throw new Error('An agent argument contains an invalid character')
  }

  const rawEnv = input.env ?? existing?.env ?? {}
  const entries = Object.entries(rawEnv)
  if (entries.length > MAX_ENV_ENTRIES) throw new Error('Too many agent environment variables')
  const env: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (!ENV_NAME.test(key)) throw new Error(`"${key}" is not a valid environment variable name`)
    env[key] = value
  }

  const rawUpdate =
    input.updateCommand === undefined ? existing?.updateCommand : input.updateCommand
  const updateCommand = rawUpdate?.trim() ?? ''
  if (updateCommand.length > MAX_UPDATE_COMMAND_LENGTH) {
    throw new Error('The update command is too long')
  }
  if (updateCommand.includes('\0')) {
    throw new Error('The update command contains an invalid character')
  }

  const enabled = input.enabled ?? existing?.enabled ?? true
  const icon = input.icon === undefined ? existing?.icon : validateIcon(input.icon, 'The icon')
  const iconDark =
    input.iconDark === undefined
      ? existing?.iconDark
      : validateIcon(input.iconDark, 'The dark icon')

  return {
    id: existing?.id ?? input.id ?? `${ACP_AGENT_ID_PREFIX}${slug(name)}`,
    name,
    command,
    args,
    env,
    ...(updateCommand.length > 0 ? { updateCommand } : {}),
    ...(icon ? { icon } : {}),
    ...(iconDark ? { iconDark } : {}),
    enabled,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
}

/**
 * Reads and writes the user's ACP agents.
 *
 * One app-wide instance, because the harness row, the model picker and the
 * driver all have to agree on which agents exist.
 */
export class AcpAgentStore {
  private agents: AcpAgent[] | null = null
  private loading: Promise<AcpAgent[]> | null = null

  constructor(private readonly storage: StorageEngine) {}

  /** Configured agents, loading the store on first use. */
  async list(): Promise<AcpAgent[]> {
    if (this.agents) return [...this.agents]
    this.loading ??= this.read()
    const agents = await this.loading
    this.loading = null
    this.agents = agents
    return [...agents]
  }

  /** Synchronous snapshot for availability gates; empty until loaded. */
  snapshot(): AcpAgent[] {
    return this.agents ? [...this.agents] : []
  }

  async get(id: string): Promise<AcpAgent | null> {
    const agents = await this.list()
    return agents.find((agent) => agent.id === id) ?? null
  }

  /**
   * Create or update one agent. Returns the saved record.
   *
   * An agent's identity is the name the user gave it, so a name that is already
   * taken is the same agent: saving it edits that record instead of appending a
   * second copy, which is how repeated clicks on Save used to leave the list with
   * three identical rows. Two different names remain two agents, whatever command
   * they start.
   */
  async save(input: AcpAgentInput): Promise<AcpAgent> {
    const agents = await this.list()
    const existing = input.id ? (agents.find((agent) => agent.id === input.id) ?? null) : null
    if (input.id && !existing) throw new Error(`No ACP agent with id ${input.id} exists`)
    const nameKey = agentNameKey(input.name)
    const sameName = agents.find(
      (agent) => agent.id !== existing?.id && agentNameKey(agent.name) === nameKey
    )
    if (existing && sameName) {
      throw new Error(
        `An agent named "${sameName.name}" already exists. Give this one another name.`
      )
    }
    const target = existing ?? sameName ?? null
    const saved = normalizeAcpAgent(input, target, Date.now())
    const next = target
      ? agents.map((agent) => (agent.id === saved.id ? saved : agent))
      : [...agents, this.uniqueId(saved, agents)]
    this.agents = next
    await this.storage.write(STORE_PATH, { version: 1, agents: next } satisfies StoredAgents)
    return saved
  }

  /** Remove one agent. Its threads keep their transcript; the harness is gone. */
  async remove(id: string): Promise<void> {
    const agents = await this.list()
    if (!agents.some((agent) => agent.id === id)) return
    this.agents = agents.filter((agent) => agent.id !== id)
    await this.storage.write(STORE_PATH, {
      version: 1,
      agents: this.agents
    } satisfies StoredAgents)
  }

  /** Every agent with what this machine resolved for its command. */
  async statuses(): Promise<AcpAgentStatus[]> {
    const agents = await this.list()
    const statuses: AcpAgentStatus[] = []
    for (const agent of agents) {
      const resolvedPath = await resolveExecutablePathAsync(agent.command)
      statuses.push({
        id: agent.id,
        name: agent.name,
        command: agent.command,
        args: [...agent.args],
        ...(acpUpdateCommandFor(agent) ? { updateCommand: acpUpdateCommandFor(agent) } : {}),
        ...(agent.icon ? { icon: agent.icon } : {}),
        ...(agent.iconDark ? { iconDark: agent.iconDark } : {}),
        enabled: agent.enabled !== false,
        ...(resolvedPath
          ? { resolvedPath }
          : { detail: `"${agent.command}" was not found on PATH.` })
      })
    }
    return statuses
  }

  private uniqueId(agent: AcpAgent, agents: readonly AcpAgent[]): AcpAgent {
    if (!agents.some((candidate) => candidate.id === agent.id)) return agent
    let counter = 2
    while (agents.some((candidate) => candidate.id === `${agent.id}-${counter}`)) counter += 1
    return { ...agent, id: `${agent.id}-${counter}` }
  }

  private async read(): Promise<AcpAgent[]> {
    const stored = await this.storage.read<StoredAgents>(STORE_PATH).catch(() => null)
    if (stored && Array.isArray(stored.agents)) {
      const agents = stored.agents
        .filter(
          (agent): agent is AcpAgent =>
            typeof agent?.id === 'string' &&
            typeof agent.name === 'string' &&
            typeof agent.command === 'string'
        )
        .map((agent) => ({ ...agent, enabled: agent.enabled !== false }))
      const healed = keepOnePerName(agents)
      // A store written before names were the identity can hold the same agent
      // several times; the healed list is written back so the next save does not
      // resurrect a duplicate.
      if (healed.length !== agents.length) {
        await this.storage.write(STORE_PATH, {
          version: 1,
          agents: healed
        } satisfies StoredAgents)
      }
      return healed
    }
    return this.importLegacy()
  }

  /** Bring the single agent the old config held into the list, once. */
  private async importLegacy(): Promise<AcpAgent[]> {
    const legacy = await this.storage
      .read<{ name?: string; command?: string; args?: string[]; env?: Record<string, string> }>(
        LEGACY_CONFIG_PATH
      )
      .catch(() => null)
    if (!legacy?.command) return []
    try {
      const now = Date.now()
      const agent = normalizeAcpAgent(
        {
          name: legacy.name ?? 'ACP agent',
          command: legacy.command,
          ...(legacy.args ? { args: legacy.args } : {}),
          ...(legacy.env ? { env: legacy.env } : {})
        },
        null,
        now
      )
      this.agents = [agent]
      await this.storage.write(STORE_PATH, { version: 1, agents: [agent] } satisfies StoredAgents)
      return [agent]
    } catch {
      return []
    }
  }
}

let sharedStore: AcpAgentStore | null = null

/** The app-wide ACP agent store, created on first use for this data root. */
export function acpAgentStore(storage: StorageEngine): AcpAgentStore {
  sharedStore ??= new AcpAgentStore(storage)
  return sharedStore
}

/**
 * The configured agents as harness descriptors.
 *
 * Every surface that lists harnesses (model picker, custom base-URL provider,
 * utility scope, orchestration targets) reads one list, and an ACP agent is a
 * harness like any other from that point of view: it has an id, a name and the
 * command that starts it. Only install/update surfaces skip them, because the
 * app never installed them.
 */
export function acpHarnessDescriptors(
  agents: readonly AcpAgent[]
): { id: string; name: string; command: string }[] {
  return agents
    .filter((agent) => agent.enabled !== false)
    .map((agent) => ({ id: agent.id, name: agent.name, command: agent.command }))
}

/** Name of one agent by harness id, or null when it is not an ACP agent. */
export function acpHarnessName(id: string): string | null {
  return sharedStore?.snapshot().find((agent) => agent.id === id)?.name ?? null
}

/** Only the enabled agents, for drivers and harness lists. */
export function enabledAcpAgents(): AcpAgent[] {
  return currentAcpAgents().filter((agent) => agent.enabled !== false)
}

/** Synchronous snapshot of the configured agents, for gates that cannot await. */
export function currentAcpAgents(): AcpAgent[] {
  return sharedStore?.snapshot() ?? []
}

/** Load the agents if a store exists yet; a no-op keeps pure modules testable. */
export async function ensureAcpAgentsLoaded(): Promise<void> {
  await sharedStore?.list()
}

/** Look up one configured agent by harness id. */
export async function findAcpAgent(id: string): Promise<AcpAgent | null> {
  return sharedStore ? sharedStore.get(id) : null
}
