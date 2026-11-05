import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { AcpAgentSettings } from '../../lib/acp'
import type { StorageEngine } from '../storage/storage-engine'
import {
  KNOWN_ACP_AGENTS,
  acpAgentConfigService,
  normalizeAcpAgentConfig
} from '../drivers/acp/acp-config'

/**
 * Harnesses counterpart for the generic ACP harness: read the configured agent,
 * save a new command, and report whether it resolves on this machine.
 *
 * The row is part of the Harnesses page because the ACP harness has no install
 * page of its own: what exists on this machine is exactly what the user saved.
 */
export function registerAcpAgentIpc(storage: StorageEngine): void {
  const configs = acpAgentConfigService(storage)

  const settings = async (): Promise<AcpAgentSettings> => ({
    status: await configs.status(),
    knownAgents: KNOWN_ACP_AGENTS.map((agent) => ({ ...agent, args: [...agent.args] }))
  })

  ipcMain.handle('acpAgent:get', () => settings())

  ipcMain.handle('acpAgent:save', async (_event, input: unknown) => {
    const record = input as Record<string, unknown> | null
    if (!record || typeof record !== 'object')
      throw new TypeError('An ACP agent config is required')
    const args = Array.isArray(record['args'])
      ? record['args'].filter((arg): arg is string => typeof arg === 'string')
      : undefined
    const env: Record<string, string> | undefined =
      record['env'] && typeof record['env'] === 'object' && !Array.isArray(record['env'])
        ? Object.fromEntries(
            Object.entries(record['env'] as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : undefined
    const config = normalizeAcpAgentConfig(
      {
        ...(typeof record['name'] === 'string' ? { name: record['name'] } : {}),
        ...(typeof record['command'] === 'string' ? { command: record['command'] } : {}),
        ...(args ? { args } : {}),
        ...(env ? { env } : {})
      },
      await configs.load()
    )
    await configs.save(config)
    return settings()
  })
}
