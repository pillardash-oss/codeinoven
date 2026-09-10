import type { HarnessAccount, HarnessAccountCreateInput } from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'

const REGISTRY_PATH = 'provider-accounts/accounts.json'
const CONTAINER_ROOT = 'provider-accounts/containers'

interface AccountRegistryFile {
  schemaVersion: 1
  accounts: HarnessAccount[]
}

const registryWriteTails = new WeakMap<StorageEngine, Promise<void>>()

export function legacyHarnessAccountId(harnessId: string): string {
  return `${harnessId}.default`
}

/** Global, atomically persisted library of user-named harness credential containers. */
export class HarnessAccountRegistry {
  constructor(private readonly storage: StorageEngine) {}

  async list(harnessId?: string): Promise<HarnessAccount[]> {
    const stored = await this.read()
    const accounts =
      harnessId &&
      !stored.accounts.some((account) => account.id === legacyHarnessAccountId(harnessId))
        ? await this.mutate(async (registry) => {
            registry.accounts = await this.ensureDefault(registry.accounts, harnessId, false)
            return [...registry.accounts]
          })
        : stored.accounts
    return accounts
      .filter((account) => harnessId === undefined || account.harnessId === harnessId)
      .sort((left, right) => {
        if (left.containerKind !== right.containerKind) {
          return left.containerKind === 'legacy-default' ? -1 : 1
        }
        return left.createdAt - right.createdAt
      })
  }

  async resolve(harnessId: string, accountId?: string): Promise<HarnessAccount> {
    const accounts = await this.list(harnessId)
    const resolvedId = accountId || legacyHarnessAccountId(harnessId)
    const account = accounts.find((candidate) => candidate.id === resolvedId)
    if (!account) throw new Error('The selected account no longer exists.')
    return account
  }

  async create(input: HarnessAccountCreateInput): Promise<HarnessAccount> {
    return this.mutate(async (registry) => {
      const accounts = await this.ensureDefault(registry.accounts, input.harnessId, false)
      this.assertUniqueLabel(accounts, input.harnessId, input.label)
      const now = Date.now()
      const account: HarnessAccount = {
        id: crypto.randomUUID(),
        harnessId: input.harnessId,
        providerId: input.providerId,
        label: input.label,
        containerKind: 'managed',
        createdAt: now,
        updatedAt: now
      }
      registry.accounts = [...accounts, account]
      await this.storage.ensureDirectory(`${CONTAINER_ROOT}/${account.id}`)
      return account
    })
  }

  async rename(accountId: string, label: string): Promise<HarnessAccount> {
    return this.mutate(async (registry) => {
      const account = registry.accounts.find((candidate) => candidate.id === accountId)
      if (!account) throw new Error('Account not found.')
      this.assertUniqueLabel(registry.accounts, account.harnessId, label, accountId)
      account.label = label
      account.updatedAt = Date.now()
      return { ...account }
    })
  }

  async remove(accountId: string): Promise<boolean> {
    return this.mutate(async (registry) => {
      const account = registry.accounts.find((candidate) => candidate.id === accountId)
      if (!account) return false
      if (account.containerKind === 'legacy-default') {
        throw new Error('The Default account cannot be removed.')
      }
      registry.accounts = registry.accounts.filter((candidate) => candidate.id !== accountId)
      await this.storage.remove(`${CONTAINER_ROOT}/${account.id}`)
      return true
    })
  }

  environment(account: HarnessAccount): NodeJS.ProcessEnv {
    if (account.containerKind === 'legacy-default') return {}
    const root = this.storage.resolve(`${CONTAINER_ROOT}/${account.id}`)
    switch (account.harnessId) {
      case 'pi':
        return { PI_CODING_AGENT_DIR: root }
      case 'opencode':
        return {
          XDG_CONFIG_HOME: `${root}/config`,
          XDG_DATA_HOME: `${root}/data`,
          XDG_STATE_HOME: `${root}/state`,
          XDG_CACHE_HOME: `${root}/cache`,
          OPENCODE_CONFIG_DIR: `${root}/config/opencode`
        }
      case 'codex':
        return { CODEX_HOME: root }
      case 'claude-code':
        return { CLAUDE_CONFIG_DIR: root }
      case 'muse':
        return { XDG_CONFIG_HOME: `${root}/config`, XDG_DATA_HOME: `${root}/data` }
      default:
        return {}
    }
  }

  private async ensureDefault(
    accounts: HarnessAccount[],
    harnessId: string,
    persist = true
  ): Promise<HarnessAccount[]> {
    if (accounts.some((account) => account.id === legacyHarnessAccountId(harnessId)))
      return accounts
    const now = Date.now()
    const next = [
      ...accounts,
      {
        id: legacyHarnessAccountId(harnessId),
        harnessId,
        providerId: '',
        label: 'Default',
        containerKind: 'legacy-default' as const,
        createdAt: now,
        updatedAt: now
      }
    ]
    if (persist) await this.write({ schemaVersion: 1, accounts: next })
    return next
  }

  private assertUniqueLabel(
    accounts: HarnessAccount[],
    harnessId: string,
    label: string,
    exceptId?: string
  ): void {
    const key = label.toLocaleLowerCase('en-US')
    if (
      accounts.some(
        (account) =>
          account.harnessId === harnessId &&
          account.id !== exceptId &&
          account.label.toLocaleLowerCase('en-US') === key
      )
    ) {
      throw new Error(`An account named "${label}" already exists for this harness.`)
    }
  }

  private async read(): Promise<AccountRegistryFile> {
    const stored = await this.storage.read<AccountRegistryFile>(REGISTRY_PATH)
    return stored?.schemaVersion === 1 && Array.isArray(stored.accounts)
      ? stored
      : { schemaVersion: 1, accounts: [] }
  }

  private async write(registry: AccountRegistryFile): Promise<void> {
    await this.storage.write(REGISTRY_PATH, registry)
  }

  private async mutate<T>(operation: (registry: AccountRegistryFile) => Promise<T>): Promise<T> {
    const preceding = registryWriteTails.get(this.storage) ?? Promise.resolve()
    let release: () => void = () => undefined
    const tail = new Promise<void>((resolve) => {
      release = resolve
    })
    registryWriteTails.set(this.storage, tail)
    await preceding
    try {
      const registry = await this.read()
      const result = await operation(registry)
      await this.write(registry)
      return result
    } finally {
      release()
    }
  }
}
