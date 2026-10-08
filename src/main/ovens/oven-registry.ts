import { extname } from 'node:path'
import { stat } from 'node:fs/promises'
import {
  isSupportedIconExtension,
  storeIconFile,
  readIconDataUrl,
  removeIconFile
} from '../../lib/icon-file'
import { randomUUID } from 'node:crypto'
import { LOCAL_OVEN_ID, type Oven, type OvenState, type SaveOvenInput } from '../../lib/ovens'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import type { OvenConnectionStatus } from '../../lib/ovens'

interface StoredOven extends Omit<
  Oven,
  'hasPrivateKey' | 'hasPassphrase' | 'hasPublicKey' | 'hasPassword' | 'imageDataUrl'
> {
  privateKeyRef?: string
  passphraseRef?: string
  publicKeyRef?: string
  imageFile?: string
  passwordRef?: string
}
interface OvenRegistryFile {
  version: 1
  ovens: StoredOven[]
  defaultOvenId: string
}
const REGISTRY_PATH = 'ovens/registry.json'
const tails = new WeakMap<StorageEngine, Promise<unknown>>()

/**
 * Ovens in list order.
 *
 * The stored `order` wins; an Oven that never had one falls back to creation
 * time so importing an old registry keeps the list stable. `byStoredOrder`
 * false sorts by creation time alone, which is how a missing order is filled in.
 */
function orderedOvens(ovens: StoredOven[], byStoredOrder = true): StoredOven[] {
  return [...ovens].sort((a, b) =>
    byStoredOrder
      ? (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt - b.createdAt
      : a.createdAt - b.createdAt
  )
}

/** The order a newly created Oven takes: one past the current last. */
function nextOrder(registry: { ovens: StoredOven[] }): number {
  return registry.ovens.reduce((max, oven) => Math.max(max, oven.order ?? -1), -1) + 1
}

export class OvenRegistry {
  constructor(
    readonly storage: StorageEngine,
    readonly vault: SecretVault
  ) {}

  async state(): Promise<OvenState> {
    const stored = await this.read()
    if (this.assignMissingOrder(stored)) await this.storage.write(REGISTRY_PATH, stored)
    const ovens: Oven[] = []
    for (const oven of orderedOvens(stored.ovens)) ovens.push(await this.present(oven))
    return {
      ovens: [
        {
          id: LOCAL_OVEN_ID,
          kind: 'local',
          name: 'Local',
          icon: 'cpu',
          color: '#6b7280',
          hasPrivateKey: false,
          hasPassphrase: false,
          hasPublicKey: false,
          hasPassword: false,
          createdAt: 0,
          updatedAt: 0
        },
        ...ovens
      ],
      defaultOvenId: stored.defaultOvenId,
      secureStorageAvailable: this.vault.isAvailable()
    }
  }

  async require(id: string): Promise<StoredOven> {
    const oven = (await this.read()).ovens.find((item) => item.id === id)
    if (!oven) throw new Error('This Oven no longer exists.')
    return oven
  }

  async recordConnectionHealth(id: string, status: OvenConnectionStatus): Promise<void> {
    await this.mutate(async (registry) => {
      const oven = registry.ovens.find((item) => item.id === id)
      if (!oven || (oven.connectionStatus?.checkedAt ?? 0) > status.checkedAt) return
      oven.connectionStatus = { ...status, specs: status.specs ?? oven.connectionStatus?.specs }
      await this.storage.write(REGISTRY_PATH, registry)
    })
  }

  async save(input: SaveOvenInput): Promise<Oven> {
    return this.mutate(async (registry) => {
      if (input.id === LOCAL_OVEN_ID) throw new Error('The Local Oven cannot be edited.')
      const existing = input.id ? registry.ovens.find((oven) => oven.id === input.id) : undefined
      if (input.id && !existing) throw new Error('This Oven no longer exists.')
      if (registry.ovens.length >= 100 && !existing)
        throw new Error('You can save up to 100 Ovens.')
      if (
        registry.ovens.some(
          (oven) =>
            oven.id !== existing?.id &&
            oven.name.toLocaleLowerCase() === input.name.toLocaleLowerCase()
        )
      ) {
        throw new Error('An Oven with this name already exists.')
      }
      const oven: StoredOven = {
        ...existing,
        id: existing?.id ?? randomUUID(),
        kind: 'ssh',
        name: input.name,
        icon: input.icon,
        customSvg: input.customSvg,
        color: input.color,
        connection: input.connection,
        order: existing?.order ?? nextOrder(registry),
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      }
      // Fresh refs allow rollback without destroying the last working credential.
      const added: string[] = []
      try {
        for (const [field, refField] of [
          ['privateKey', 'privateKeyRef'],
          ['passphrase', 'passphraseRef'],
          ['publicKey', 'publicKeyRef'],
          ['password', 'passwordRef']
        ] as const) {
          const secret = input[field]
          if (secret === undefined) continue
          if (!secret) {
            delete oven[refField]
            continue
          }
          const ref = await this.vault.save(secret)
          added.push(ref)
          oven[refField] = ref
        }
        if (oven.connection?.authentication === 'vault' && !oven.privateKeyRef) {
          throw new Error('Import a private key before using vaulted authentication.')
        }
        if (oven.connection?.authentication === 'password' && !oven.passwordRef)
          throw new Error('Enter the SSH account password.')
        const imageDirectory = this.storage.resolve(`ovens/${oven.id}`)
        if (input.imagePath) {
          const info = await stat(input.imagePath)
          if (
            !info.isFile() ||
            info.size > 2 * 1024 * 1024 ||
            !isSupportedIconExtension(extname(input.imagePath))
          )
            throw new Error('Choose an icon image smaller than 2 MiB.')
          oven.imageFile = await storeIconFile(imageDirectory, input.imagePath, existing?.imageFile)
        } else if (input.clearImage) {
          if (existing?.imageFile) await removeIconFile(imageDirectory, existing.imageFile)
          oven.imageFile = undefined
        }
        const index = registry.ovens.findIndex((item) => item.id === oven.id)
        // An edit keeps the Oven where it sits; only a new Oven is appended.
        // Rewriting the list on every edit was what reordered the whole panel.
        if (index >= 0) registry.ovens[index] = oven
        else registry.ovens.push(oven)
        await this.storage.write(REGISTRY_PATH, registry)
      } catch (error) {
        for (const ref of added) await this.vault.remove(ref)
        throw error
      }
      // Old secrets can now be discarded. They never appear in renderer responses.
      for (const field of [
        'privateKeyRef',
        'passphraseRef',
        'publicKeyRef',
        'passwordRef'
      ] as const) {
        const ref = existing?.[field]
        if (ref && ref !== oven[field]) await this.vault.remove(ref)
      }
      return this.present(oven)
    })
  }

  async setDefault(id: string): Promise<OvenState> {
    await this.mutate(async (registry) => {
      if (id !== LOCAL_OVEN_ID && !registry.ovens.some((oven) => oven.id === id))
        throw new Error('This Oven no longer exists.')
      registry.defaultOvenId = id
      await this.storage.write(REGISTRY_PATH, registry)
    })
    return this.state()
  }

  /**
   * Persist a manual order. The ids are the SSH Ovens in the order the user
   * dropped them; Local is never part of the list because it is always first.
   * An id the registry does not know is ignored rather than failing the whole
   * drag, so a stale renderer cannot wedge reordering.
   */
  async reorder(ids: string[]): Promise<OvenState> {
    await this.mutate(async (registry) => {
      const positions = new Map(ids.map((id, index) => [id, index]))
      for (const oven of registry.ovens) {
        const position = positions.get(oven.id)
        if (position !== undefined) oven.order = position
      }
      await this.storage.write(REGISTRY_PATH, registry)
    })
    return this.state()
  }

  /**
   * Give every Oven an order, using creation time for any that never had one.
   * Returns whether anything changed so callers can persist the migration once.
   */
  private assignMissingOrder(registry: OvenRegistryFile): boolean {
    if (registry.ovens.every((oven) => typeof oven.order === 'number')) return false
    orderedOvens(registry.ovens, false).forEach((oven, index) => {
      oven.order = index
    })
    return true
  }

  async remove(id: string): Promise<OvenState> {
    await this.mutate(async (registry) => {
      if (id === LOCAL_OVEN_ID) throw new Error('The Local Oven cannot be removed.')
      const oven = registry.ovens.find((item) => item.id === id)
      if (!oven) return
      registry.ovens = registry.ovens.filter((item) => item.id !== id)
      if (registry.defaultOvenId === id) registry.defaultOvenId = LOCAL_OVEN_ID
      await this.storage.write(REGISTRY_PATH, registry)
      if (oven.imageFile)
        await removeIconFile(this.storage.resolve(`ovens/${oven.id}`), oven.imageFile)
      for (const ref of [
        oven.privateKeyRef,
        oven.passphraseRef,
        oven.publicKeyRef,
        oven.passwordRef
      ]) {
        if (ref) await this.vault.remove(ref)
      }
    })
    return this.state()
  }

  private async present(oven: StoredOven): Promise<Oven> {
    const { privateKeyRef, passphraseRef, publicKeyRef, passwordRef, imageFile, ...metadata } = oven
    return {
      ...metadata,
      imageDataUrl: imageFile
        ? ((await readIconDataUrl(this.storage.resolve(`ovens/${oven.id}`), imageFile)) ??
          undefined)
        : undefined,
      hasPrivateKey: Boolean(privateKeyRef),
      hasPassphrase: Boolean(passphraseRef),
      hasPublicKey: Boolean(publicKeyRef),
      hasPassword: Boolean(passwordRef)
    }
  }

  private async read(): Promise<OvenRegistryFile> {
    const stored = await this.storage.read<OvenRegistryFile>(REGISTRY_PATH)
    if (!stored) return { version: 1, ovens: [], defaultOvenId: LOCAL_OVEN_ID }
    if (stored.version !== 1 || !Array.isArray(stored.ovens))
      throw new Error('Unsupported Oven registry format.')
    return stored
  }

  private async mutate<T>(operation: (registry: OvenRegistryFile) => Promise<T>): Promise<T> {
    const previous = tails.get(this.storage) ?? Promise.resolve()
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const registry = await this.read()
        // Every mutation normalizes order first, so a save or reorder can never
        // work from partially-ordered data.
        this.assignMissingOrder(registry)
        return operation(registry)
      })
    tails.set(this.storage, current)
    return current
  }
}
