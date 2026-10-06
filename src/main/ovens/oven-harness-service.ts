import type { OvenHarnessInventoryItem, OvenProbe } from '../../lib/ovens'
import { ovenHarnessIdForCommand } from '../../lib/ovens'
import { findHarness } from '../agents/harness-registry'
import {
  extractHarnessVersion,
  harnessSelfUpdateArgs,
  latestHarnessVersion
} from '../agents/harness-update-service'
import type { HarnessInstallMethod } from '../../lib/types'
import { compareVersions } from '../../lib/version-compare'
import { harnessUninstallCommand } from '../agents/harness-install-service'
import { OVEN_HARNESS_PATH, OVEN_NPM_ENV } from './oven-harness-paths'
import { sshQuote } from './oven-ssh'
import type { OvenService } from './oven-service'
import { Logger } from '../system/logger'
import { withOvenHarnessMutation } from './oven-operation-lock'
import type { StorageEngine } from '../storage/storage-engine'

/** A harness update is a real install mutation; give it room but never hang forever. */
const UPDATE_TIMEOUT_MS = 5 * 60_000
/** Reuse one inventory per oven briefly so an expanded row does not re-probe. */
const INVENTORY_TTL_MS = 30_000
const UPDATE_METADATA_TTL_MS = 5 * 60_000
/** Last known inventory per Oven, so an offline Oven still answers its model list. */
const INVENTORY_STORE_PATH = 'ovens/harness-inventory.json'

type InventoryHealth = OvenHarnessInventoryItem['health']

interface CachedInventory {
  items: OvenHarnessInventoryItem[]
  checkedAt: number
  platform: string
}

/** The persisted copy of every Oven's last known harness inventory. */
interface StoredInventories {
  version: 1
  ovens: Record<string, CachedInventory>
}

const EMPTY_INVENTORIES: StoredInventories = { version: 1, ovens: {} }

/**
 * Harness inventory and single-harness management for remote Ovens.
 *
 * Installed versions and health come from the oven-side service itself, which
 * already knows every hosted command. Latest versions and update availability
 * are resolved here, on the machine that can reach the registries, and merged
 * into the same rows so the UI never has to join two lists.
 *
 * Every mutating operation takes a per-oven-and-harness lock, and waits for that
 * harness's active runs first: replacing a binary while it is running is the
 * failure the lock exists to prevent, not a nice-to-have.
 */
export class OvenHarnessService {
  private readonly inventories = new Map<string, CachedInventory>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private stored: StoredInventories | null = null
  private storedLoading: Promise<StoredInventories> | null = null
  private readonly latestVersions = new Map<
    string,
    { checkedAt: number; result: Awaited<ReturnType<typeof latestHarnessVersion>> }
  >()
  private autoUpdateTimer: ReturnType<typeof setInterval> | undefined
  private autoUpdateInitial: ReturnType<typeof setTimeout> | undefined
  private autoUpdateRunning = false

  constructor(
    private readonly service: OvenService,
    private readonly storage: StorageEngine
  ) {}

  /** Apply the shared per-harness auto-update preferences to every remote oven. */
  startAutoUpdates(): void {
    if (this.autoUpdateTimer) return
    this.autoUpdateInitial = setTimeout(() => {
      this.autoUpdateInitial = undefined
      void this.runAutoUpdates()
    }, 10_000)
    this.autoUpdateInitial.unref?.()
    this.autoUpdateTimer = setInterval(() => void this.runAutoUpdates(), 15 * 60_000)
    this.autoUpdateTimer.unref?.()
  }

  stopAutoUpdates(): void {
    if (this.autoUpdateInitial) clearTimeout(this.autoUpdateInitial)
    this.autoUpdateInitial = undefined
    if (this.autoUpdateTimer) clearInterval(this.autoUpdateTimer)
    this.autoUpdateTimer = undefined
  }

  private async runAutoUpdates(): Promise<void> {
    if (this.autoUpdateRunning) return
    this.autoUpdateRunning = true
    try {
      const preferences = await this.storage.read<Record<string, boolean>>(
        'harness-auto-update.json'
      )
      if (!preferences || !Object.values(preferences).some(Boolean)) return
      const state = await this.service.registry.state()
      for (const oven of state.ovens) {
        if (oven.kind !== 'ssh') continue
        let inventory: OvenHarnessInventoryItem[]
        try {
          inventory = await this.getInventory(oven.id)
        } catch (error) {
          Logger.info('Remote oven auto-updates were skipped', {
            ovenId: oven.id,
            reason: error instanceof Error ? error.message : String(error)
          })
          continue
        }
        for (const [harnessId, enabled] of Object.entries(preferences)) {
          if (!enabled) continue
          try {
            const item = this.requireRow(inventory, harnessId)
            if (item.health === 'healthy' && item.updateAvailable)
              await this.updateHarness(oven.id, harnessId)
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error)
            Logger.info('Remote harness auto-update was skipped', {
              ovenId: oven.id,
              harnessId,
              reason
            })
            // SSH uses exit 255 for connection failures; ordinary remote command
            // failures retain their own exit code and do not stop other harnesses.
            if (
              /^SSH connection failed \((?:255|disconnected)\)/u.test(reason) ||
              reason === 'The Oven did not respond before the connection timeout.'
            ) {
              this.inventories.delete(oven.id)
              Logger.info('Remaining auto-updates were skipped because the Oven is unavailable', {
                ovenId: oven.id
              })
              break
            }
          }
        }
      }
    } catch (error) {
      Logger.info('Remote harness auto-update check failed', {
        reason: error instanceof Error ? error.message : String(error)
      })
    } finally {
      this.autoUpdateRunning = false
    }
  }

  /** Serialize work per oven and harness, so updates never overlap each other. */
  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(task)
    const tail = result.then(
      () => undefined,
      () => undefined
    )
    this.locks.set(key, tail)
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key)
    })
    return result
  }

  /** True while any run of this harness is live on the oven. */
  private async hasActiveRun(ovenId: string, command: string): Promise<boolean> {
    const runs = await this.service.runs(ovenId)
    return runs.some((run) => run.status === 'running' && run.command === command)
  }

  /** Updates and removals wait for active turns, while the shared gate blocks new ones. */
  private async waitForHarnessIdle(ovenId: string, command: string): Promise<void> {
    while (await this.hasActiveRun(ovenId, command))
      await new Promise((resolve) => setTimeout(resolve, 1_000))
  }

  /**
   * Inventory every hosted harness on one Oven.
   *
   * `refresh` forces a fresh oven-side version scan; without it a recent result
   * is reused so expanding a row stays instant. The oven-side service scans the
   * whole canonical harness list, so a harness the user installed themselves is
   * picked up on the next ping instead of staying invisible.
   *
   * Every successful scan is persisted, and an unreachable Oven answers with
   * that last known copy rather than nothing: the app keeps a local record of
   * what each Oven had installed, which is what lets a remote thread's model
   * picker and thread rows know the Oven's harnesses without a live probe.
   */
  async getInventory(ovenId: string, refresh = false): Promise<OvenHarnessInventoryItem[]> {
    const cached = this.inventories.get(ovenId)
    if (!refresh && cached && Date.now() - cached.checkedAt < INVENTORY_TTL_MS) return cached.items
    try {
      const probe = await this.service.probe(ovenId, refresh)
      const items = await this.mergeLatest(this.probeItems(probe))
      const entry: CachedInventory = { items, checkedAt: Date.now(), platform: probe.platform }
      this.inventories.set(ovenId, entry)
      await this.persistInventory(ovenId, entry)
      return items
    } catch (error) {
      // A refresh that fails must stay a failure: the caller forced it to
      // verify a mutation that just ran, and a stale row would misreport it.
      if (refresh) throw error
      const stored = (await this.inventoryStore()).ovens[ovenId]
      if (!stored) throw error
      this.inventories.set(ovenId, stored)
      Logger.dev('Using the last known Oven harness inventory', {
        ovenId,
        checkedAt: stored.checkedAt
      })
      return stored.items
    }
  }

  /** The persisted inventory table, read once and then kept in memory. */
  private inventoryStore(): Promise<StoredInventories> {
    if (this.stored) return Promise.resolve(this.stored)
    if (this.storedLoading) return this.storedLoading
    const loading = this.storage
      .read<StoredInventories>(INVENTORY_STORE_PATH)
      .then((value): StoredInventories =>
        value && value.version === 1 && value.ovens ? value : EMPTY_INVENTORIES
      )
      .catch((): StoredInventories => EMPTY_INVENTORIES)
      .then((value) => {
        this.stored = value
        this.storedLoading = null
        return value
      })
    this.storedLoading = loading
    return loading
  }

  /**
   * Persist one Oven's inventory after a successful scan.
   *
   * A failed write never fails the scan it belongs to: the in-memory copy is
   * already correct, and the next scan retries the file.
   */
  private async persistInventory(ovenId: string, entry: CachedInventory): Promise<void> {
    const store = await this.inventoryStore()
    const next: StoredInventories = { version: 1, ovens: { ...store.ovens, [ovenId]: entry } }
    this.stored = next
    await this.storage.write(INVENTORY_STORE_PATH, next).catch((error: unknown) =>
      Logger.dev('Oven harness inventory could not be persisted', {
        ovenId,
        error: error instanceof Error ? error.message : String(error)
      })
    )
  }

  /** Translate the oven probe into inventory rows, tolerating an older service. */
  private probeItems(probe: OvenProbe): OvenHarnessInventoryItem[] {
    if (probe.inventory && probe.inventory.length > 0) return probe.inventory
    // An oven running an older service still gets a usable list: presence only.
    return probe.harnesses.map((entry) => ({
      harnessId: ovenHarnessIdForCommand(entry.command) ?? entry.command,
      command: entry.command,
      executablePath: entry.path,
      installedVersion: null,
      health: (entry.path ? 'unknown' : 'missing') satisfies InventoryHealth,
      ...(entry.path ? {} : { issueCategory: 'not-installed' as const }),
      updateAvailable: false,
      checkedAt: Date.now()
    }))
  }

  /** Attach the latest published version to each installed row, in small batches. */
  private async mergeLatest(
    items: OvenHarnessInventoryItem[]
  ): Promise<OvenHarnessInventoryItem[]> {
    const merged: OvenHarnessInventoryItem[] = []
    const batchSize = 3
    for (let offset = 0; offset < items.length; offset += batchSize) {
      const batch = await Promise.all(
        items.slice(offset, offset + batchSize).map(async (item) => {
          if (item.health !== 'healthy' || !item.installedVersion) return item
          const cached = this.latestVersions.get(item.harnessId)
          const latest =
            cached && Date.now() - cached.checkedAt < UPDATE_METADATA_TTL_MS
              ? cached.result
              : await latestHarnessVersion(item.harnessId)
          if (!cached || Date.now() - cached.checkedAt >= UPDATE_METADATA_TTL_MS)
            this.latestVersions.set(item.harnessId, { checkedAt: Date.now(), result: latest })
          if (!latest.ok) return { ...item, updateAvailable: false }
          const installed = extractHarnessVersion(item.installedVersion) ?? item.installedVersion
          return {
            ...item,
            latestVersion: latest.version,
            updateAvailable: compareVersions(latest.version, installed) > 0
          }
        })
      )
      merged.push(...batch)
    }
    return merged
  }

  /**
   * Update one harness in place using the harness's own documented self-update
   * command. Returns the refreshed row so the caller never has to re-probe.
   */
  async updateHarness(ovenId: string, harnessId: string): Promise<OvenHarnessInventoryItem> {
    return this.logMutation('update', ovenId, harnessId, () =>
      this.withLock(`${ovenId}:${harnessId}`, async () => {
        const descriptor = findHarness(harnessId)
        if (!descriptor) throw new Error('That harness is not in the app registry.')
        const args = harnessSelfUpdateArgs(harnessId)
        if (!args)
          throw new Error(
            `${descriptor.name} does not document an unattended update command. Update it on the Oven itself.`
          )
        return withOvenHarnessMutation(ovenId, descriptor.command, async () => {
          await this.waitForHarnessIdle(ovenId, descriptor.command)
          const platform =
            this.inventories.get(ovenId)?.platform ?? (await this.service.probe(ovenId)).platform
          Logger.info('Updating a harness on an oven', { ovenId, harnessId })
          await this.service.ssh.execute(
            ovenId,
            `${platform === 'win32' ? '' : `${OVEN_HARNESS_PATH} ${OVEN_NPM_ENV} `}${[descriptor.command, ...args].map(sshQuote).join(' ')}`,
            '',
            UPDATE_TIMEOUT_MS
          )
          this.inventories.delete(ovenId)
          return this.requireRow(await this.getInventory(ovenId, true), harnessId)
        })
      })
    )
  }

  /**
   * Uninstall one harness using its documented removal command.
   *
   * This is genuinely destructive   the argument list can include the user's
   * harness home directory   so the caller is expected to have confirmed with the
   * user first. CodeInOven never decides on its own to remove a harness.
   */
  async uninstallHarness(ovenId: string, harnessId: string): Promise<OvenHarnessInventoryItem> {
    return this.logMutation('uninstall', ovenId, harnessId, () =>
      this.withLock(`${ovenId}:${harnessId}`, async () => {
        const descriptor = findHarness(harnessId)
        if (!descriptor) throw new Error('That harness is not in the app registry.')
        const current = this.requireRow(await this.getInventory(ovenId), harnessId)
        if (current.health === 'missing') return current
        const method = methodForPath(current.executablePath)
        const removal = harnessUninstallCommand(harnessId, method)
        if (!removal)
          throw new Error(
            `${descriptor.name} documents no unattended uninstall for ${method} installs. Remove it on the Oven itself.`
          )
        return withOvenHarnessMutation(ovenId, descriptor.command, async () => {
          await this.waitForHarnessIdle(ovenId, descriptor.command)
          Logger.info('Uninstalling a harness on an oven', { ovenId, harnessId, method })
          await this.service.ssh.execute(
            ovenId,
            `${current.executablePath?.includes('/harnesses/npm/') ? `${OVEN_HARNESS_PATH} ${OVEN_NPM_ENV} ` : ''}${[removal.command, ...removal.args].map(sshQuote).join(' ')}`,
            '',
            UPDATE_TIMEOUT_MS
          )
          this.inventories.delete(ovenId)
          return this.requireRow(await this.getInventory(ovenId, true), harnessId)
        })
      })
    )
  }

  private async logMutation(
    action: 'update' | 'uninstall',
    ovenId: string,
    harnessId: string,
    task: () => Promise<OvenHarnessInventoryItem>
  ): Promise<OvenHarnessInventoryItem> {
    const started = Date.now()
    const context = { action, ovenId, harnessId }
    Logger.info('Oven harness operation queued', context)
    try {
      const result = await task()
      Logger.info('Oven harness operation finished', {
        ...context,
        durationMs: Date.now() - started,
        version: result.installedVersion,
        health: result.health
      })
      return result
    } catch (error) {
      Logger.error('Oven harness operation failed', {
        ...context,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : 'Unknown operation failure'
      })
      throw error
    }
  }

  private requireRow(
    inventory: OvenHarnessInventoryItem[],
    harnessId: string
  ): OvenHarnessInventoryItem {
    const row = inventory.find((item) => item.harnessId === harnessId)
    if (!row) throw new Error('The Oven did not report that harness.')
    return row
  }
}

/** Infer the install method from the resolved binary path so removal matches it. */
function methodForPath(path: string | null): HarnessInstallMethod {
  const lower = (path ?? '').toLowerCase()
  if (
    lower.includes('/harnesses/npm/') ||
    lower.includes('node_modules') ||
    lower.includes('.npm-global') ||
    lower.includes('nvm')
  )
    return 'npm'
  if (lower.includes('cellar') || lower.includes('homebrew')) return 'brew'
  if (lower.includes('windowsapps')) return 'winget'
  return 'native'
}
