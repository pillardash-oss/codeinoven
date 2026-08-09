import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import { isAbsolute } from 'node:path'
import type { ProviderAccountLoginOptions } from '../lib/types'
import { validateEntityId } from './ipc-validation'
import { ProviderAccountOrchestrator } from './provider-account-orchestrator'

const LOGIN_FIELDS = new Set(['mode', 'accountHint', 'sso', 'providerId'])
const LOGIN_MODES = new Set(['default', 'subscription', 'console', 'device'])

/** Register the validated provider sign-in renderer boundary. */
export function registerProviderAccountIpc(auth = new ProviderAccountOrchestrator()): void {
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
  ipcMain.handle('providerAccounts:beginLogin', (_, rawHarnessId: unknown, rawOptions?: unknown) =>
    auth.beginLogin(
      validateEntityId(rawHarnessId, 'Harness ID', 256),
      parseLoginOptions(rawOptions)
    )
  )
  ipcMain.handle('providerAccounts:listOffered', (_, rawHarnessId: unknown) =>
    auth.listOffered(validateEntityId(rawHarnessId, 'Harness ID', 256))
  )
  ipcMain.handle('providerAccounts:logout', (_, rawHarnessId: unknown, rawProviderId?: unknown) =>
    auth.logout(
      validateEntityId(rawHarnessId, 'Harness ID', 256),
      rawProviderId === undefined ? undefined : validateEntityId(rawProviderId, 'Provider ID', 256)
    )
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
      : { providerId: validateEntityId(options['providerId'], 'Provider ID', 256) })
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
