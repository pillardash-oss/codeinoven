import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { isAbsolute } from 'node:path'
import type { HarnessAccount, ProviderAccountLoginOptions } from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { validateEntityId } from './ipc-validation'
import type { HarnessAuthAccount, HarnessAuthStatus } from '../drivers/driver.interface'
import { ProviderAccountOrchestrator } from '../providers/provider-account-orchestrator'
import {
  HarnessAccountRegistry,
  legacyHarnessAccountId
} from '../providers/harness-account-registry'

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
      const capabilities = await auth.capabilities(harnessId)
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
    const capabilities = await auth.capabilities(pending.harnessId)
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
  ipcMain.handle('providerAccounts:setDefault', async (_, rawAccountId: unknown) => {
    const account = await accounts.setDefault(validateEntityId(rawAccountId, 'Account ID', 256))
    return accounts.list(account.harnessId)
  })
  ipcMain.handle('providerAccounts:activate', async (_, rawAccountId: unknown) => {
    const accountId = validateEntityId(rawAccountId, 'Account ID', 256)
    const account = (await accounts.list()).find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('The selected account no longer exists.')
    // Only the harness's own default store holds several credentials that a
    // switch can pick between; a managed container is already isolated, and a
    // harness without a switch command has nothing to activate.
    if (account.containerKind !== 'legacy-default' || !account.sourceId) return
    const capabilities = await auth.capabilities(account.harnessId)
    if (!capabilities?.accountActivation) return
    await auth.activateAccount(
      account.harnessId,
      account.providerId,
      account.sourceId,
      accounts.environment(account)
    )
  })
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
    async (_, rawHarnessId: unknown, rawProjectPath?: unknown, rawAccountId?: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const projectPath = parseOptionalAbsolutePath(rawProjectPath)
      const capabilities = await auth.capabilities(harnessId)
      if (!capabilities) {
        return {
          capabilities: null,
          state: 'unsupported' as const,
          accounts: [],
          detail: `Authentication is not supported for harness: ${harnessId}`
        }
      }
      // An account-scoped read answers "is THIS account signed in?" against the
      // account's own credential home. The unscoped read merges the default home
      // with every container and cannot say which of them a sign-in wrote.
      const accountId =
        rawAccountId === undefined ? undefined : validateEntityId(rawAccountId, 'Account ID', 256)
      if (accountId !== undefined) {
        // An id the registry does not know is not automatically wrong: the
        // legacy default id names the harness's shared credential home and is
        // legitimate without a row. Every other unknown id is a stale binding.
        const account = (await accounts.list(harnessId)).find(
          (candidate) => candidate.id === accountId
        )
        if (!account && accountId !== legacyHarnessAccountId(harnessId)) {
          throw new Error('The selected account no longer exists.')
        }
        return {
          capabilities,
          ...(await auth.getStatus(
            harnessId,
            projectPath,
            account ? accounts.environment(account) : {}
          ))
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
      const account = await loginAccount(accounts, harnessId, options)
      return auth.beginLogin(
        harnessId,
        account.providerId ? { ...options, providerId: account.providerId } : options,
        accounts.environment(account),
        account.id
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
): Promise<HarnessAccount> {
  // `finalizePending` promotes an in-memory pending entry into a persisted
  // account while preserving its `pending-` id, so a `pending-` prefix no
  // longer implies the account is still in-memory pending. Resolve persisted
  // accounts first, then fall back to the in-memory pending store for accounts
  // that have not been finalized yet (e.g. mid add-provider login flow).
  const persisted = (await accounts.list(harnessId)).find((account) => account.id === accountId)
  if (persisted) return persisted
  return accounts.pendingAccount(harnessId, accountId)
}

/**
 * The account a sign-in must write into.
 *
 * A login is always about one account, and it has to be the account the next turn
 * on this harness reads: credentials written anywhere else are attributed to
 * whichever account tracks that store, which is how a re-authentication used to
 * land on an account the user never picked while the expired one stayed signed
 * out. The runtime's own resolution is therefore the authority here, and an
 * in-memory pending container - the one account the registry cannot resolve yet,
 * during the add-provider flow - is the single honored exception.
 */
async function loginAccount(
  accounts: HarnessAccountRegistry,
  harnessId: string,
  options: ProviderAccountLoginOptions
): Promise<HarnessAccount> {
  if (options.accountId?.startsWith('pending-')) {
    const persisted = (await accounts.list(harnessId)).find(
      (account) => account.id === options.accountId
    )
    // `finalizePending` promotes a pending entry while keeping its id, so a
    // persisted row wins when the registry and the in-memory store both know it.
    return persisted ?? accounts.pendingAccount(harnessId, options.accountId)
  }
  try {
    return await accounts.resolveForProvider(harnessId, options.providerId, options.accountId)
  } catch {
    // Only a dangling selection on a multi-account harness reaches here (the
    // other paths degrade to the harness default). Stale thread data must not
    // block the user from signing in again, so resolve without the account id.
    return accounts.resolveForProvider(harnessId, options.providerId)
  }
}
