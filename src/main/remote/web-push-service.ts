import webPush, { type PushSubscription } from 'web-push'
import { join } from 'node:path'
import { ensureDir, getConfigRoot, readJson, writeJson } from '../../lib/utils'
import type { AgentNotificationPayload } from '../../lib/ipc-contract'
import { Logger } from '../system/logger'

const PUSH_DIRECTORY = join(getConfigRoot(), 'remote', 'web-push')
const VAPID_PATH = join(PUSH_DIRECTORY, 'vapid.json')
const SUBSCRIPTIONS_PATH = join(PUSH_DIRECTORY, 'subscriptions.json')
const MAX_SUBSCRIPTIONS = 32

interface StoredVapidKeys {
  publicKey: string
  privateKey: string
}

export interface RemotePushSubscription extends PushSubscription {
  expirationTime: number | null
}

interface StoredSubscription {
  deviceId: string
  subscription: RemotePushSubscription
  updatedAt: number
}

interface StoredSubscriptionFile {
  version: 1
  subscriptions: StoredSubscription[]
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function validateSubscription(value: RemotePushSubscription): RemotePushSubscription {
  const endpoint = boundedString(value.endpoint, 'Push endpoint', 4_096)
  const parsed = new URL(endpoint)
  if (parsed.protocol !== 'https:') throw new TypeError('Push endpoint must use HTTPS')
  const p256dh = boundedString(value.keys?.p256dh, 'Push encryption key', 1_024)
  const auth = boundedString(value.keys?.auth, 'Push authentication secret', 1_024)
  return {
    endpoint,
    expirationTime:
      typeof value.expirationTime === 'number' && Number.isFinite(value.expirationTime)
        ? value.expirationTime
        : null,
    keys: { p256dh, auth }
  }
}

function statusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null
  return typeof error.statusCode === 'number' ? error.statusCode : null
}

class RemoteWebPushService {
  private initialization: Promise<void> | null = null
  private vapid: StoredVapidKeys | null = null
  private subscriptions = new Map<string, StoredSubscription>()

  private async initialize(): Promise<void> {
    if (this.initialization) return this.initialization
    this.initialization = (async () => {
      await ensureDir(PUSH_DIRECTORY)
      this.vapid = await readJson<StoredVapidKeys>(VAPID_PATH)
      if (!this.vapid?.publicKey || !this.vapid.privateKey) {
        this.vapid = webPush.generateVAPIDKeys()
        await writeJson(VAPID_PATH, this.vapid)
      }
      const stored = await readJson<StoredSubscriptionFile>(SUBSCRIPTIONS_PATH)
      for (const entry of stored?.subscriptions ?? []) {
        try {
          const subscription = validateSubscription(entry.subscription)
          this.subscriptions.set(subscription.endpoint, { ...entry, subscription })
        } catch {
          // Invalid legacy/corrupt records are omitted when the next write occurs.
        }
      }
      webPush.setVapidDetails(
        'mailto:hey@pillardash.com',
        this.vapid.publicKey,
        this.vapid.privateKey
      )
    })()
    return this.initialization
  }

  async publicKey(): Promise<string> {
    await this.initialize()
    if (!this.vapid) throw new Error('Web Push keys are unavailable')
    return this.vapid.publicKey
  }

  async subscribe(deviceId: string, raw: RemotePushSubscription): Promise<void> {
    await this.initialize()
    const subscription = validateSubscription(raw)
    this.subscriptions.set(subscription.endpoint, { deviceId, subscription, updatedAt: Date.now() })
    while (this.subscriptions.size > MAX_SUBSCRIPTIONS) {
      const oldest = [...this.subscriptions.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0]
      if (!oldest) break
      this.subscriptions.delete(oldest.subscription.endpoint)
    }
    await this.persist()
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.initialize()
    if (!this.subscriptions.delete(endpoint)) return
    await this.persist()
  }

  async removeDevice(deviceId: string): Promise<void> {
    await this.initialize()
    let changed = false
    for (const [endpoint, entry] of this.subscriptions) {
      if (entry.deviceId !== deviceId) continue
      this.subscriptions.delete(endpoint)
      changed = true
    }
    if (changed) await this.persist()
  }

  async send(payload: AgentNotificationPayload): Promise<void> {
    await this.initialize()
    const expired: string[] = []
    await Promise.all(
      [...this.subscriptions.values()].map(async ({ subscription }) => {
        try {
          await webPush.sendNotification(subscription, JSON.stringify(payload), {
            TTL: 300,
            urgency: payload.kind === 'attention' || payload.kind === 'error' ? 'high' : 'normal'
          })
        } catch (error) {
          const code = statusCode(error)
          if (code === 404 || code === 410) expired.push(subscription.endpoint)
          else Logger.dev('Remote Web Push delivery failed:', error)
        }
      })
    )
    if (expired.length === 0) return
    for (const endpoint of expired) this.subscriptions.delete(endpoint)
    await this.persist()
  }

  private async persist(): Promise<void> {
    await writeJson(SUBSCRIPTIONS_PATH, {
      version: 1,
      subscriptions: [...this.subscriptions.values()]
    } satisfies StoredSubscriptionFile)
  }
}

export const remoteWebPush = new RemoteWebPushService()
