import { createHash, randomUUID } from 'node:crypto'
import type {
  HarnessAccount,
  HarnessAccountCreateInput,
  PendingHarnessAccount,
  ProviderAccountAuthEntry
} from '../../lib/types'
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

function additionalLegacyAccountId(harnessId: string, providerId: string): string {
  const digest = createHash('sha256').update(providerId).digest('hex').slice(0, 16)
  return `${harnessId}.default.${digest}`
}

/** Global, atomically persisted library of provider credentials and their labels. */
export class HarnessAccountRegistry {
  private readonly pending = new Map<string, PendingHarnessAccount>()

  constructor(private readonly storage: StorageEngine) {}

  async list(harnessId?: string): Promise<HarnessAccount[]> {
    const stored = await this.read()
    return stored.accounts
      .filter((account) => harnessId === undefined || account.harnessId === harnessId)
      .sort((left, right) => left.createdAt - right.createdAt)
  }

  /** Mirror credentials from a harness's original home into provider-level account rows. */
  async reconcileLegacy(
    harnessId: string,
    authenticated: ProviderAccountAuthEntry[]
  ): Promise<HarnessAccount[]> {
    return this.mutate(async (registry) => {
      const active = authenticated
        .filter((account) => account.active !== false)
        .sort((left, right) => left.providerId.localeCompare(right.providerId))
      const managed = registry.accounts.filter(
        (account) => account.harnessId === harnessId && account.containerKind === 'managed'
      )
      const priorLegacy = registry.accounts.filter(
        (account) => account.harnessId === harnessId && account.containerKind === 'legacy-default'
      )
      const occupiedIds = new Set(managed.map((account) => account.id))
      const labels = new Set(managed.map((account) => account.label.toLocaleLowerCase('en-US')))
      const now = Date.now()
      const legacy: HarnessAccount[] = []
      for (const [index, discovered] of active.entries()) {
        const existing = priorLegacy.find((account) => account.providerId === discovered.providerId)
        const id =
          existing?.id ??
          (index === 0 && !occupiedIds.has(legacyHarnessAccountId(harnessId))
            ? legacyHarnessAccountId(harnessId)
            : additionalLegacyAccountId(harnessId, discovered.providerId))
        occupiedIds.add(id)
        const providerName = discovered.label || discovered.providerId
        let label = existing?.label && existing.label !== 'Default' ? existing.label : ''
        if (!label) {
          let sequence = 1
          while (labels.has(`${providerName}-${sequence}`.toLocaleLowerCase('en-US'))) sequence += 1
          label = `${providerName}-${sequence}`
        }
        labels.add(label.toLocaleLowerCase('en-US'))
        legacy.push({
          id,
          harnessId,
          providerId: discovered.providerId,
          providerName,
          label,
          containerKind: 'legacy-default',
          createdAt: existing?.createdAt ?? now + index,
          updatedAt: existing?.updatedAt ?? now
        })
      }
      registry.accounts = [
        ...registry.accounts.filter(
          (account) => account.harnessId !== harnessId || account.containerKind === 'managed'
        ),
        ...legacy
      ]
      return [...managed, ...legacy].sort((left, right) => left.createdAt - right.createdAt)
    })
  }

  async resolve(harnessId: string, accountId?: string): Promise<HarnessAccount> {
    const accounts = await this.list(harnessId)
    if (accounts.length === 1) return accounts[0]
    const resolvedId = accountId || legacyHarnessAccountId(harnessId)
    const account = accounts.find((candidate) => candidate.id === resolvedId)
    if (account) return account
    if (accounts.length > 0 && (!accountId || resolvedId === legacyHarnessAccountId(harnessId))) {
      return accounts[0]
    }
    if (resolvedId === legacyHarnessAccountId(harnessId)) {
      const now = Date.now()
      return {
        id: resolvedId,
        harnessId,
        providerId: '',
        providerName: '',
        label: 'Default',
        containerKind: 'legacy-default',
        createdAt: now,
        updatedAt: now
      }
    }
    throw new Error('The selected account no longer exists.')
  }

  /** Resolve an account only from credentials belonging to the selected provider. */
  async resolveForProvider(
    harnessId: string,
    providerId: string | undefined,
    accountId?: string
  ): Promise<HarnessAccount> {
    if (!providerId) return this.resolve(harnessId, accountId)
    const providerAccounts = (await this.list(harnessId)).filter(
      (account) => account.providerId === providerId
    )
    if (providerAccounts.length === 1) return providerAccounts[0]
    const selected = providerAccounts.find((account) => account.id === accountId)
    if (selected) return selected
    if (providerAccounts.length > 0) return providerAccounts[0]
    return this.virtualLegacyAccount(harnessId, providerId)
  }

  /** Reserve an isolated home without making it visible as an account. */
  async prepare(harnessId: string, providerId = ''): Promise<PendingHarnessAccount> {
    const pending: PendingHarnessAccount = {
      id: `pending-${randomUUID()}`,
      harnessId,
      providerId
    }
    await this.storage.ensureDirectory(`${CONTAINER_ROOT}/${pending.id}`)
    this.pending.set(pending.id, pending)
    return pending
  }

  pendingAccount(harnessId: string, pendingId: string): HarnessAccount {
    const pending = this.pending.get(pendingId)
    if (!pending || pending.harnessId !== harnessId) {
      throw new Error('The pending account no longer exists.')
    }
    const now = Date.now()
    return {
      ...pending,
      providerName: pending.providerId,
      label: '',
      containerKind: 'managed',
      createdAt: now,
      updatedAt: now
    }
  }

  pendingAccountById(pendingId: string): HarnessAccount {
    const pending = this.pending.get(pendingId)
    if (!pending) throw new Error('The pending account no longer exists.')
    return this.pendingAccount(pending.harnessId, pendingId)
  }

  async finalizePending(
    pendingId: string,
    providerId: string,
    providerName: string,
    label?: string
  ): Promise<HarnessAccount> {
    const pending = this.pending.get(pendingId)
    if (!pending) throw new Error('The pending account no longer exists.')
    const account = await this.create({
      harnessId: pending.harnessId,
      providerId,
      ...(label?.trim() ? { label } : {}),
      id: pending.id,
      providerName
    })
    this.pending.delete(pendingId)
    return account
  }

  async cancelPending(pendingId: string): Promise<void> {
    const pending = this.pending.get(pendingId)
    if (!pending) return
    this.pending.delete(pendingId)
    await this.storage.remove(`${CONTAINER_ROOT}/${pending.id}`)
  }

  private async create(
    input: HarnessAccountCreateInput & { id?: string; providerName?: string }
  ): Promise<HarnessAccount> {
    return this.mutate(async (registry) => {
      const label =
        input.label?.trim() ||
        this.nextGeneratedLabel(
          registry.accounts,
          input.harnessId,
          input.providerName || input.providerId
        )
      this.assertUniqueLabel(registry.accounts, input.harnessId, label)
      const now = Date.now()
      const account: HarnessAccount = {
        id: input.id ?? randomUUID(),
        harnessId: input.harnessId,
        providerId: input.providerId,
        providerName: input.providerName || input.providerId,
        label,
        containerKind: 'managed',
        createdAt: now,
        updatedAt: now
      }
      registry.accounts = [...registry.accounts, account]
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

  /** Repair a pre-finalization-era managed row after its credential is discovered. */
  async adoptManagedCredential(
    accountId: string,
    providerId: string,
    providerName: string
  ): Promise<HarnessAccount> {
    return this.mutate(async (registry) => {
      const account = registry.accounts.find((candidate) => candidate.id === accountId)
      if (!account || account.containerKind !== 'managed') throw new Error('Account not found.')
      const oldGeneratedLabel = new RegExp(`^${escapeRegExp(account.harnessId)}-\\d+$`, 'iu')
      account.providerId = providerId
      account.providerName = providerName
      if (!account.label || oldGeneratedLabel.test(account.label)) {
        account.label = this.nextGeneratedLabel(
          registry.accounts.filter((candidate) => candidate.id !== accountId),
          account.harnessId,
          providerName
        )
      }
      account.updatedAt = Date.now()
      return { ...account }
    })
  }

  async remove(accountId: string): Promise<boolean> {
    return this.mutate(async (registry) => {
      const account = registry.accounts.find((candidate) => candidate.id === accountId)
      if (!account) return false
      registry.accounts = registry.accounts.filter((candidate) => candidate.id !== accountId)
      if (account.containerKind === 'managed') {
        await this.storage.remove(`${CONTAINER_ROOT}/${account.id}`)
      }
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

  private nextGeneratedLabel(
    accounts: HarnessAccount[],
    harnessId: string,
    providerName: string
  ): string {
    const base = providerName.trim() || 'Account'
    const used = new Set(
      accounts
        .filter((account) => account.harnessId === harnessId)
        .map((account) => account.label.toLocaleLowerCase('en-US'))
    )
    let sequence = 1
    while (used.has(`${base}-${sequence}`.toLocaleLowerCase('en-US'))) sequence += 1
    return `${base}-${sequence}`
  }

  private async read(): Promise<AccountRegistryFile> {
    const stored = await this.storage.read<AccountRegistryFile>(REGISTRY_PATH)
    return stored?.schemaVersion === 1 && Array.isArray(stored.accounts)
      ? {
          ...stored,
          accounts: stored.accounts.map((account) => ({
            ...account,
            providerName: account.providerName || account.providerId
          }))
        }
      : { schemaVersion: 1, accounts: [] }
  }

  private virtualLegacyAccount(harnessId: string, providerId = ''): HarnessAccount {
    const now = Date.now()
    return {
      id: legacyHarnessAccountId(harnessId),
      harnessId,
      providerId,
      providerName: providerId,
      label: 'Default',
      containerKind: 'legacy-default',
      createdAt: now,
      updatedAt: now
    }
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}
