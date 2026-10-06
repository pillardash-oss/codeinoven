import type { OvenConnectionStatus, SaveOvenInput } from '../../lib/ovens'
import type { OvenRegistry } from './oven-registry'
import { OvenSsh } from './oven-ssh'
import { remoteShell } from './oven-remote-shell'
import { connectionInspectCommand } from './oven-remote-command'
import { arch, availableParallelism, hostname, platform, totalmem, homedir } from 'node:os'
import { statfs } from 'node:fs/promises'

export async function localOvenConnection(): Promise<OvenConnectionStatus> {
  const disk = await statfs(homedir())
  return {
    state: 'connected',
    checkedAt: Date.now(),
    latencyMs: 0,
    specs: {
      hostname: hostname(),
      platform: platform(),
      architecture: arch(),
      cpuCount: availableParallelism(),
      memoryBytes: totalmem(),
      diskBytes: disk.blocks * disk.bsize,
      diskAvailableBytes: disk.bavail * disk.bsize,
      nodeVersion: process.versions.node
    }
  }
}

// Read-only OS tools: connection health never depends on the managed Node service.
// The command itself is chosen from the shell the Oven presents, so a native
// Windows Oven reports its own facts instead of failing a POSIX probe.
export async function inspectOvenConnection(
  ssh: OvenSsh,
  id: string
): Promise<OvenConnectionStatus> {
  const start = Date.now()
  try {
    const command = connectionInspectCommand(await remoteShell(ssh, id))
    const lines = (await ssh.execute(id, command, '', 20_000)).trim().split(/\r?\n/u)
    if (lines.length !== 8) throw new Error('The Oven returned an unexpected system response.')
    const number = (value: string): number => {
      const result = Number(value)
      if (!Number.isFinite(result) || result < 0)
        throw new Error('Invalid Oven system specification.')
      return result
    }
    return {
      state: 'connected',
      checkedAt: Date.now(),
      latencyMs: Date.now() - start,
      specs: {
        hostname: lines[0],
        platform: lines[1],
        architecture: lines[2],
        cpuCount: number(lines[3]),
        memoryBytes: number(lines[4]),
        diskBytes: number(lines[5]),
        diskAvailableBytes: number(lines[6]),
        nodeVersion: lines[7] === 'not-installed' ? null : lines[7]
      }
    }
  } catch (error) {
    return {
      state: 'disconnected',
      checkedAt: Date.now(),
      error: error instanceof Error ? error.message : 'Could not connect to this Oven.'
    }
  }
}

export async function testDraftConnection(
  registry: OvenRegistry,
  input: SaveOvenInput
): Promise<OvenConnectionStatus> {
  const existing = input.id ? await registry.require(input.id) : undefined
  const secrets = new Map<string, string>()
  const draft = {
    id: 'draft',
    kind: 'ssh' as const,
    name: input.name,
    icon: input.icon,
    color: input.color,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...existing,
    connection: input.connection
  }
  for (const [field, ref] of [
    ['password', 'passwordRef'],
    ['privateKey', 'privateKeyRef'],
    ['passphrase', 'passphraseRef']
  ] as const) {
    if (input[field] === undefined) continue
    if (!registry.vault.isAvailable()) throw new Error('The encrypted secret vault is unavailable.')
    if (!input[field]) {
      delete draft[ref]
      continue
    }
    const key = `draft:${field}`
    secrets.set(key, input[field])
    draft[ref] = key
  }
  const ssh = new OvenSsh({
    storage: registry.storage,
    require: async () => draft,
    vault: { resolve: async (ref) => secrets.get(ref) ?? registry.vault.resolve(ref) }
  })
  try {
    return await inspectOvenConnection(ssh, 'draft')
  } finally {
    secrets.clear()
  }
}

export async function inspectOvenConnectionWithHarnesses(
  ssh: OvenSsh,
  id: string
): Promise<OvenConnectionStatus> {
  const base = await inspectOvenConnection(ssh, id)
  return base
}
