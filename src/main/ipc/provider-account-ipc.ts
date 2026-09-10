import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { isAbsolute } from 'node:path'
import type { ProviderAccountLoginOptions } from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { validateEntityId } from './ipc-validation'
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
  ipcMain.handle('providerAccounts:list', (_, rawHarnessId?: unknown) =>
    accounts.list(
      rawHarnessId === undefined ? undefined : validateEntityId(rawHarnessId, 'Harness ID', 256)
    )
  )
  ipcMain.handle('providerAccounts:create', (_, rawInput: unknown) => {
    const input = record(rawInput, 'Account')
    rejectUnknownFields(input, new Set(['harnessId', 'providerId', 'label']), 'account')
    return accounts.create({
      harnessId: validateEntityId(input['harnessId'], 'Harness ID', 256),
      providerId: text(input['providerId'], 'Provider ID', 256, false, true),
      label: text(input['label'], 'Account label', 80)
    })
  })
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
      return { capabilities, ...(await auth.getStatus(harnessId, projectPath)) }
    }
  )
  ipcMain.handle(
    'providerAccounts:beginLogin',
    async (_, rawHarnessId: unknown, rawOptions?: unknown) => {
      const harnessId = validateEntityId(rawHarnessId, 'Harness ID', 256)
      const options = parseLoginOptions(rawOptions)
      const account = options.accountId
        ? await accounts.resolve(harnessId, options.accountId)
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
      const account = accountId ? await accounts.resolve(harnessId, accountId) : undefined
      return auth.logout(
        harnessId,
        rawProviderId === undefined
          ? undefined
          : validateEntityId(rawProviderId, 'Provider ID', 256),
        account ? accounts.environment(account) : undefined
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
      const account = accountId ? await accounts.resolve(harnessId, accountId) : undefined
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
      const account = accountId ? await accounts.resolve(harnessId, accountId) : undefined
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
