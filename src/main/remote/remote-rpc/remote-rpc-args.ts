/**
 * Argument coercion for the remote RPC bridge.
 *
 * The bridge transports args as JSON, so every argument arrives untyped. These
 * helpers mirror the desktop IPC handler expectations: required values throw a
 * `TypeError`, optional values stay `undefined` when absent.
 */

import type { AgentAccountUsageOverrides } from '../../../lib/types'
import type { RemoteRpcDeviceContext } from '../../../lib/remote-rpc'

export function requireRemoteDeviceId(device?: RemoteRpcDeviceContext): string {
  if (!device?.deviceId) throw new Error('Authenticated device identity is required')
  return device.deviceId
}

export function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string argument')
  return value
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function requireBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Expected a boolean argument')
  return value
}

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new TypeError('Expected a boolean argument')
  return value
}

export function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  return value
}

export function optionalAccountUsageOverrides(
  value: unknown
): AgentAccountUsageOverrides | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Expected an overrides object argument')
  }
  const raw = value as Record<string, unknown>
  const harnessId = optionalString(raw.harnessId)
  const providerId = optionalString(raw.providerId)
  const accountId = optionalString(raw.accountId)
  if (harnessId === undefined && providerId === undefined && accountId === undefined) {
    return undefined
  }
  return {
    ...(harnessId !== undefined ? { harnessId } : {}),
    ...(providerId !== undefined ? { providerId } : {}),
    ...(accountId !== undefined ? { accountId } : {})
  }
}
