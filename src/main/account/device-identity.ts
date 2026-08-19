/**
 * Stable desktop device identity for account profile sync.
 *
 * Every desktop install gets a permanent random device id (persisted under the
 * config root) so its usage snapshot can be stored per device on the account
 * profile. The label defaults to the machine hostname so the usage page can
 * show "Personal Mac", "Work Linux", etc.
 */

import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { StorageEngine } from '../storage/storage-engine'

export interface DeviceIdentity {
  deviceId: string
  deviceLabel: string
  platform: string
}

interface DeviceIdentityRecord {
  deviceId: string
  label: string
  platform: string
}

const DEVICE_IDENTITY_PATH = 'account/device.json'

export async function loadDeviceIdentity(storage: StorageEngine): Promise<DeviceIdentity> {
  const existing = await storage.read<DeviceIdentityRecord>(DEVICE_IDENTITY_PATH)
  if (existing && typeof existing.deviceId === 'string' && existing.deviceId) {
    return {
      deviceId: existing.deviceId,
      deviceLabel: existing.label || hostname(),
      platform: existing.platform || process.platform
    }
  }
  const record: DeviceIdentityRecord = {
    deviceId: randomUUID(),
    label: hostname(),
    platform: process.platform
  }
  await storage.write(DEVICE_IDENTITY_PATH, record).catch(() => undefined)
  return {
    deviceId: record.deviceId,
    deviceLabel: record.label,
    platform: record.platform
  }
}
