import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { lstat, open } from 'node:fs/promises'
import type { HarnessAccount } from '../../lib/types'
import type { HarnessAccountRegistry } from '../providers/harness-account-registry'
import type { OvenService } from './oven-service'

const synchronizing = new WeakMap<OvenService, Map<string, Promise<Record<string, string>>>>()

/** Coalesce account uploads so concurrent chats cannot replace each other's credentials. */
export function syncOvenAccount(
  service: OvenService,
  registry: HarnessAccountRegistry,
  ovenId: string,
  account: HarnessAccount
): Promise<Record<string, string>> {
  let pending = synchronizing.get(service)
  if (!pending) {
    pending = new Map()
    synchronizing.set(service, pending)
  }
  const key = `${ovenId}:${account.id}`
  const existing = pending.get(key)
  if (existing) return existing
  const task = copyOvenAccount(service, registry, ovenId, account).finally(() =>
    pending.delete(key)
  )
  pending.set(key, task)
  return task
}

/** Copy portable credential/config files, never transcripts, caches or local account homes. */
async function copyOvenAccount(
  service: OvenService,
  registry: HarnessAccountRegistry,
  ovenId: string,
  account: HarnessAccount
): Promise<Record<string, string>> {
  const probe = await service.probe(ovenId)
  const root = `${probe.home}/.config/pillardash/codeinoven-oven/accounts/${account.id}`
  const local = registry.environment(account)
  const home = homedir()
  let source: string
  let names: string[]
  let environment: Record<string, string>
  switch (account.harnessId) {
    case 'codex':
      source = local.CODEX_HOME ?? join(home, '.codex')
      names = ['auth.json', 'config.toml']
      environment = { CODEX_HOME: root }
      break
    case 'claude-code':
      source = local.CLAUDE_CONFIG_DIR ?? join(home, '.claude')
      names = ['.credentials.json', 'settings.json']
      environment = { CLAUDE_CONFIG_DIR: root }
      break
    case 'pi':
      source = local.PI_CODING_AGENT_DIR ?? join(home, '.pi/agent')
      names = ['auth.json', 'models.json', 'settings.json']
      environment = { PI_CODING_AGENT_DIR: root }
      break
    case 'opencode':
      source = local.XDG_DATA_HOME ?? join(home, '.local/share')
      names = ['opencode/auth.json', 'config/opencode.json', 'config/opencode.jsonc']
      environment = {
        XDG_DATA_HOME: `${root}/data`,
        XDG_CONFIG_HOME: `${root}/config`,
        XDG_STATE_HOME: `${root}/state`,
        XDG_CACHE_HOME: `${root}/cache`,
        OPENCODE_CONFIG_DIR: `${root}/config/opencode`
      }
      break
    case 'muse':
      source = local.XDG_CONFIG_HOME ?? join(home, '.config')
      names = ['muse/auth.json']
      environment = { XDG_CONFIG_HOME: root, XDG_DATA_HOME: `${root}/data` }
      break
    case 'cline':
      source = join(home, '.cline/data')
      names = ['settings/providers.json']
      environment = { CLINE_DATA_DIR: root }
      break
    default:
      return {}
  }
  await service.workspace(ovenId, { operation: 'ensure', root })
  let synchronized: Record<string, string> = {}
  try {
    const marker = await service.workspace(ovenId, {
      operation: 'read',
      root,
      path: 'source-fingerprints.json',
      offset: 0
    })
    const raw = JSON.parse(Buffer.from(marker.data ?? '', 'base64').toString('utf8')) as unknown
    if (raw && typeof raw === 'object' && !Array.isArray(raw))
      synchronized = raw as Record<string, string>
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('ENOENT'))) throw error
  }
  for (const name of names) {
    const config = account.harnessId === 'opencode' && name.startsWith('config/')
    const path = config
      ? join(local.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode', name.slice(7))
      : join(source, name)
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) continue
    if (!info.isFile() || info.size > 1024 * 1024)
      throw new Error('An account configuration file is not portable or exceeds 1 MiB.')
    const destination =
      account.harnessId === 'opencode'
        ? config
          ? `config/opencode/${name.slice(7)}`
          : `data/${name}`
        : name
    if (destination.includes('/'))
      await service.workspace(ovenId, {
        operation: 'mkdir',
        root,
        path: destination.slice(0, destination.lastIndexOf('/'))
      })
    // Atomic credential replacement is performed by the remote service, rather than
    // writing into a file a running harness might read halfway through an upload.
    const file = await open(path, 'r')
    try {
      const data = await file.readFile()
      const fingerprint = createHash('sha256').update(data).digest('hex')
      // A remote OAuth refresh owns its latest credential. Only a changed local
      // source can replace it; an unchanged local snapshot never rolls it back.
      if (synchronized[name] !== fingerprint) {
        await service.putFile(ovenId, root, destination, data, 0o600)
        synchronized[name] = fingerprint
      }
    } finally {
      await file.close()
    }
  }
  if (
    account.containerKind === 'legacy-default' &&
    !Object.keys(synchronized).some(
      (name) => name.includes('auth') || name.includes('credentials') || name.includes('providers')
    )
  )
    return {}
  await service.putFile(
    ovenId,
    root,
    'source-fingerprints.json',
    Buffer.from(JSON.stringify(synchronized)),
    0o600
  )
  return environment
}
