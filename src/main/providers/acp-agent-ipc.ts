import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { AcpAgent, AcpAgentAuthStatus, AcpAgentSettings } from '../../lib/acp'
import type { StorageEngine } from '../storage/storage-engine'
import { KNOWN_ACP_AGENTS, acpAgentStore, isAcpAgentId } from '../drivers/acp/acp-agents-store'
import { acpAgentAuthStatus, authenticateAcpAgent } from './acp-agent-auth'

export interface AcpAgentIpcOptions {
  /** Called after any change, so drivers, catalogs and the harness list agree. */
  onAgentsChanged?: () => void | Promise<void>
}

/**
 * CRUD for the ACP agents the user adds in Harnesses.
 *
 * These are user-owned records, not installs: the app never downloads or
 * launches anything until the user's own command is saved, and removing an
 * agent removes only the record.
 */
export function registerAcpAgentIpc(
  storage: StorageEngine,
  options: AcpAgentIpcOptions = {}
): void {
  const store = acpAgentStore(storage)

  const settings = async (): Promise<AcpAgentSettings> => ({
    agents: await store.statuses(),
    knownAgents: KNOWN_ACP_AGENTS.map((agent) => ({ ...agent, args: [...agent.args] }))
  })

  ipcMain.handle('acpAgents:list', () => settings())

  ipcMain.handle('acpAgents:save', async (_event, input: unknown) => {
    const record = readInput(input)
    await store.save(record)
    await options.onAgentsChanged?.()
    return settings()
  })

  ipcMain.handle('acpAgents:remove', async (_event, id: unknown) => {
    if (typeof id !== 'string' || !isAcpAgentId(id))
      throw new TypeError('An ACP agent id is required')
    await store.remove(id)
    await options.onAgentsChanged?.()
    return settings()
  })

  /**
   * Sign-in state of one agent, asked of the agent.
   *
   * These two channels are the ACP sign-in surface: the agent declares its
   * methods and runs the one the user picks, so no provider list of our own is
   * involved and no command is ever guessed on the user's behalf.
   */
  ipcMain.handle(
    'acpAgents:authStatus',
    async (_event, id: unknown, projectPath?: unknown): Promise<AcpAgentAuthStatus> => {
      const agent = await requireAgent(store, id)
      return acpAgentAuthStatus(
        agent,
        typeof projectPath === 'string' && projectPath.length > 0 ? projectPath : undefined
      )
    }
  )

  ipcMain.handle(
    'acpAgents:authenticate',
    async (_event, id: unknown, methodId: unknown, projectPath?: unknown) => {
      const agent = await requireAgent(store, id)
      if (typeof methodId !== 'string' || methodId.trim().length === 0) {
        throw new TypeError('A sign-in method id is required')
      }
      const status = await authenticateAcpAgent(
        agent.id,
        methodId.trim(),
        typeof projectPath === 'string' && projectPath.length > 0 ? projectPath : undefined
      )
      // The catalog was probed while the agent was still signed out (a refused
      // session is what produced the sign-in card), so its cached answer has to
      // go: without this the model picker keeps the empty catalog until the TTL.
      await options.onAgentsChanged?.()
      return status
    }
  )
}

/** Resolve one configured agent, refusing an id the store does not own. */
async function requireAgent(
  store: ReturnType<typeof acpAgentStore>,
  id: unknown
): Promise<AcpAgent> {
  if (typeof id !== 'string' || !isAcpAgentId(id))
    throw new TypeError('An ACP agent id is required')
  const agent = await store.get(id)
  if (!agent) throw new Error('This ACP agent is no longer configured. Add it again in Harnesses.')
  return agent
}

/** Narrow one renderer submission without trusting its shape. */
function readInput(input: unknown): {
  id?: string
  name: string
  command: string
  args: string[]
  icon?: string | null
  iconDark?: string | null
  enabled?: boolean
} {
  if (typeof input !== 'object' || input === null) throw new TypeError('An ACP agent is required')
  const record = input as Record<string, unknown>
  const name = typeof record['name'] === 'string' ? record['name'] : ''
  const command = typeof record['command'] === 'string' ? record['command'] : ''
  const args = Array.isArray(record['args'])
    ? record['args'].filter((arg): arg is string => typeof arg === 'string')
    : []
  const id =
    typeof record['id'] === 'string' && isAcpAgentId(record['id']) ? record['id'] : undefined
  const icon = record['icon']
  const iconDark = record['iconDark']
  const enabled = record['enabled']
  return {
    ...(typeof enabled === 'boolean' ? { enabled } : {}),
    ...(id ? { id } : {}),
    name,
    command,
    args,
    ...(typeof icon === 'string' || icon === null ? { icon } : {}),
    ...(typeof iconDark === 'string' || iconDark === null ? { iconDark } : {})
  }
}
