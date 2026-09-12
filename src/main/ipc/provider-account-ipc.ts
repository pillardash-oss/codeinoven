import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { isAbsolute } from 'node:path'
import type { ProviderAccountLoginOptions } from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { validateEntityId } from './ipc-validation'
import type { HarnessAuthAccount, HarnessAuthStatus } from '../drivers/driver.interface'
import { ProviderAccountOrchestrator } from '../providers/provider-account-orchestrator'
import { HarnessAccountRegistry } from '../providers/harness-account-registry'

const LOGIN_FIELDS = new Set(['mode', 'accountHint', 'sso', 'providerId', 'accountId'])
const LOGIN_MODES = new Set(['default', 'subscription', 'console', 'device'])

/** Register the validated provider sign-in renderer boundary. */
export function registerProviderAccountIpc(
  storage: StorageEngine,
  auth = new ProviderAccountOrchestrator(),
  removeAccount?: (accountId: string) => Promise<boolean>
): void {
  const accounts = new HarnessAccountRegistry(storage)
  const lastAccountSync = new Map<string, number>()
  ipcMain.handle(
    'providerAccounts:list',
    async (_, rawHarnessId?: unknown, rawRefresh?: unknown) => {
      if (rawHarnessId === undefined) return accounts.list()
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const refresh = rawRefresh === undefined ? false : boolean(rawRefresh, 'Refresh')
      const capabilities = auth.capabilities(harnessId)
      const shouldSync = refresh || Date.now() - (lastAccountSync.get(harnessId) ?? 0) >= 30_000
      if (capabilities && shouldSync) {
        const status = await auth.getStatus(harnessId)
        if (status.state !== 'error' && status.state !== 'unknown') {
          await accounts.reconcileLegacy(harnessId, status.accounts)
        }
        const unresolved = (await accounts.list(harnessId)).filter(
          (account) => account.containerKind === 'managed' && account.providerId === ''
        )
        for (const account of unresolved) {
          const managedStatus = await auth.getStatus(
            harnessId,
            undefined,
            accounts.environment(account)
          )
          const authenticated = managedStatus.accounts.find((entry) => entry.active !== false)
          if (authenticated) {
            await accounts.adoptManagedCredential(
              account.id,
              authenticated.providerId,
              authenticated.label
            )
          } else if (managedStatus.state === 'unauthenticated') {
            await (removeAccount ?? ((accountId: string) => accounts.remove(accountId)))(account.id)
          }
        }
        lastAccountSync.set(harnessId, Date.now())
      }
      return accounts.list(harnessId)
    }
  )
  ipcMain.handle('providerAccounts:prepare', (_, rawHarnessId: unknown, rawProviderId?: unknown) =>
    accounts.prepare(
      validateEntityId(rawHarnessId, 'Harness ID', 256),
      rawProviderId === undefined ? undefined : validateEntityId(rawProviderId, 'Provider ID', 256)
    )
  )
  ipcMain.handle('providerAccounts:inspectPending', async (_, rawPendingAccountId: unknown) => {
    const pending = accounts.pendingAccountById(
      validateEntityId(rawPendingAccountId, 'Pending account ID', 256)
    )
    const capabilities = auth.capabilities(pending.harnessId)
    return {
      capabilities,
      ...(await auth.getStatus(pending.harnessId, undefined, accounts.environment(pending)))
    }
  })
  ipcMain.handle(
    'providerAccounts:finalizePending',
    async (_, rawPendingAccountId: unknown, rawProviderId: unknown, rawLabel?: unknown) => {
      const pendingId = validateEntityId(rawPendingAccountId, 'Pending account ID', 256)
      const providerId = validateEntityId(rawProviderId, 'Provider ID', 256)
      const pending = accounts.pendingAccountById(pendingId)
      const status = await auth.getStatus(
        pending.harnessId,
        undefined,
        accounts.environment(pending)
      )
      const authenticated = status.accounts.find(
        (account) => account.active !== false && account.providerId === providerId
      )
      if (!authenticated) {
        throw new Error('The provider did not report a completed sign-in.')
      }
      return accounts.finalizePending(
        pendingId,
        providerId,
        authenticated.label || providerId,
        rawLabel === undefined ? undefined : text(rawLabel, 'Account label', 80, false, true)
      )
    }
  )
  ipcMain.handle('providerAccounts:cancelPending', (_, rawPendingAccountId: unknown) =>
    accounts.cancelPending(validateEntityId(rawPendingAccountId, 'Pending account ID', 256))
  )
  ipcMain.handle('providerAccounts:rename', (_, rawAccountId: unknown, rawLabel: unknown) =>
    accounts.rename(
      validateEntityId(rawAccountId, 'Account ID', 256),
      text(rawLabel, 'Account label', 80)
    )
  )
  ipcMain.handle('providerAccounts:remove', (_, rawAccountId: unknown) =>
    (removeAccount ?? ((accountId: string) => accounts.remove(accountId)))(
      validateEntityId(rawAccountId, 'Account ID', 256)
    )
  )
  async function mergedAuthStatus(
    harnessId: string,
    projectPath?: string
  ): Promise<HarnessAuthStatus> {
    const status = await auth.getStatus(harnessId, projectPath)
    if (status.state === 'error' || status.state === 'unknown') return status
    // Legacy reconciliation must only see default-home credentials; merged
    // container entries are display-only for the provider check list.
    await accounts.reconcileLegacy(harnessId, status.accounts)
    lastAccountSync.set(harnessId, Date.now())
    const managed = (await accounts.list(harnessId)).filter(
      (account) => account.containerKind === 'managed' && account.providerId !== ''
    )
    const mergedAccounts: HarnessAuthAccount[] = [...status.accounts]
    let authenticated = status.state === 'authenticated'
    for (const account of managed) {
      const containerStatus = await auth.getStatus(
        harnessId,
        projectPath,
        accounts.environment(account)
      )
      if (containerStatus.state === 'authenticated') authenticated = true
      if (containerStatus.state === 'error' || containerStatus.state === 'unknown') continue
      for (const entry of containerStatus.accounts) {
        if (entry.active === false) continue
        // Two accounts may legitimately hold the same provider; keep both, but
        // mark the container one with its human label so they stay tellable.
        const sameProvider = mergedAccounts.some(
          (candidate) =>
            candidate.providerId === entry.providerId && candidate.method === entry.method
        )
        mergedAccounts.push({
          ...entry,
          id: `${entry.id}.${account.id}`,
          ...(sameProvider && account.label ? { label: `${entry.label} (${account.label})` } : {})
        })
      }
    }
    return {
      ...status,
      state: authenticated ? 'authenticated' : 'unauthenticated',
      accounts: mergedAccounts
    }
  }

  ipcMain.handle(
    'providerAccounts:getAuthStatus',
    async (_, rawHarnessId: unknown, rawProjectPath?: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const projectPath = parseOptionalAbsolutePath(rawProjectPath)
      const capabilities = auth.capabilities(harnessId)
      if (!capabilities) {
        return {
          capabilities: null,
          state: 'unsupported' as const,
          accounts: [],
          detail: `Authentication is not supported for harness: ${harnessId}`
        }
      }
      const status = await mergedAuthStatus(harnessId, projectPath)
      return { capabilities, ...status }
    }
  )
  ipcMain.handle(
    'providerAccounts:beginLogin',
    async (_, rawHarnessId: unknown, rawOptions?: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const options = parseLoginOptions(rawOptions)
      const account = options.accountId
        ? await resolveCredentialAccount(accounts, harnessId, options.accountId)
        : undefined
      return auth.beginLogin(
        harnessId,
        options,
        account ? accounts.environment(account) : undefined
      )
    }
  )
  ipcMain.handle('providerAccounts:listOffered', (_, rawHarnessId: unknown) =>
    auth.listOffered(validateEntityId(rawHarnessId, 'Harness ID', 256))
  )
  ipcMain.handle(
    'providerAccounts:logout',
    async (_, rawHarnessId: unknown, rawProviderId?: unknown, rawAccountId?: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const accountId =
        rawAccountId === undefined ? undefined : validateEntityId(rawAccountId, 'Account ID', 256)
      if (!accountId && rawProviderId !== undefined) {
        // Provider-level disconnect is only unambiguous with a single account.
        const providerId = validateEntityId(rawProviderId, 'Provider ID', 256)
        const matching = (await accounts.list(harnessId)).filter(
          (account) => account.providerId === providerId
        )
        if (matching.length > 1) {
          const providerName = matching[0]?.providerName || providerId
          throw new Error(
            `${providerName} is connected on ${matching.length} accounts. Disconnect it from the accounts tab to choose which one.`
          )
        }
      }
      const account = accountId
        ? await resolveCredentialAccount(accounts, harnessId, accountId)
        : undefined
      return auth.logout(
        harnessId,
        rawProviderId === undefined
          ? undefined
          : validateEntityId(rawProviderId, 'Provider ID', 256),
        account ? accounts.environment(account) : undefined,
        account?.providerName ?? account?.label
      )
    }
  )
  ipcMain.handle(
    'providerAccounts:setApiKey',
    async (
      _,
      rawHarnessId: unknown,
      rawProviderId: unknown,
      rawApiKey: unknown,
      rawAccountId?: unknown
    ) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const accountId =
        rawAccountId === undefined ? undefined : validateEntityId(rawAccountId, 'Account ID', 256)
      const account = accountId
        ? await resolveCredentialAccount(accounts, harnessId, accountId)
        : undefined
      return auth.setCredential(
        harnessId,
        validateEntityId(rawProviderId, 'Provider ID', 256),
        text(rawApiKey, 'API key', 4_096, true),
        account ? accounts.environment(account) : undefined
      )
    }
  )
  ipcMain.handle(
    'providerAccounts:beginOAuthLogin',
    async (_, rawHarnessId: unknown, rawProviderId: unknown, rawAccountId?: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const accountId =
        rawAccountId === undefined ? undefined : validateEntityId(rawAccountId, 'Account ID', 256)
      const account = accountId
        ? await resolveCredentialAccount(accounts, harnessId, accountId)
        : undefined
      return auth.beginOAuthLogin(
        harnessId,
        validateEntityId(rawProviderId, 'Provider ID', 256),
        account ? accounts.environment(account) : undefined
      )
    }
  )
  ipcMain.handle(
    'providerAccounts:respondOAuthPrompt',
    (_, rawLoginId: unknown, rawValue: unknown) =>
      auth.respondOAuthPrompt(
        validateEntityId(rawLoginId, 'Login ID', 256),
        text(rawValue, 'Prompt answer', 4_096, true)
      )
  )
  ipcMain.handle('providerAccounts:cancelOAuthLogin', (_, rawLoginId: unknown) =>
    auth.cancelOAuthLogin(validateEntityId(rawLoginId, 'Login ID', 256))
  )
  ipcMain.handle('providerAccounts:getHidden', (_, rawHarnessId: unknown) =>
    auth.getHiddenProviders(validateEntityId(rawHarnessId, 'Harness ID', 256))
  )
  ipcMain.handle(
    'providerAccounts:setHidden',
    (_, rawHarnessId: unknown, rawProviderId: unknown, rawHidden: unknown) =>
      auth.setProviderHidden(
        validateEntityId(rawHarnessId, 'Harness ID', 256),
        validateEntityId(rawProviderId, 'Provider ID', 256),
        boolean(rawHidden, 'Hidden')
      )
  )
}

function parseLoginOptions(value: unknown): ProviderAccountLoginOptions {
  if (value === undefined) return {}
  const options = record(value, 'Login options')
  rejectUnknownFields(options, LOGIN_FIELDS, 'login options')
  const mode = options['mode']
  if (mode !== undefined && (typeof mode !== 'string' || !LOGIN_MODES.has(mode))) {
    throw new TypeError('Login mode is invalid')
  }
  return {
    ...(mode === undefined ? {} : { mode: mode as ProviderAccountLoginOptions['mode'] }),
    ...(options['accountHint'] === undefined
      ? {}
      : { accountHint: text(options['accountHint'], 'Account hint', 320) }),
    ...(options['sso'] === undefined ? {} : { sso: boolean(options['sso'], 'SSO') }),
    ...(options['providerId'] === undefined
      ? {}
      : { providerId: validateEntityId(options['providerId'], 'Provider ID', 256) }),
    ...(options['accountId'] === undefined
      ? {}
      : { accountId: validateEntityId(options['accountId'], 'Account ID', 256) })
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string
): void {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TypeError(`Unsupported ${label} field: ${field}`)
  }
}

function text(
  value: unknown,
  label: string,
  maximumLength: number,
  preserveWhitespace = false,
  allowEmpty = false
): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  const normalized = preserveWhitespace ? value : value.trim()
  if (
    (!allowEmpty && normalized.length === 0) ||
    normalized.length > maximumLength ||
    normalized.includes('\0')
  ) {
    throw new TypeError(`${label} is invalid`)
  }
  return normalized
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`)
  return value
}

function parseOptionalAbsolutePath(value: unknown): string | undefined {
  if (value === undefined) return undefined
  const path = text(value, 'Project path', 4_096)
  if (!isAbsolute(path)) throw new TypeError('Project path must be absolute')
  return path
}

async function resolveCredentialAccount(
  accounts: HarnessAccountRegistry,
  harnessId: string,
  accountId: string
) {
  if (accountId.startsWith('pending-')) return accounts.pendingAccount(harnessId, accountId)
  return accounts.resolve(harnessId, accountId)
}
