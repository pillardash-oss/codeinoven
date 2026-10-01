import { randomUUID } from 'node:crypto'
import { LOCAL_OVEN_ID, type Oven, type OvenState, type SaveOvenInput } from '../../lib/ovens'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'

interface StoredOven extends Omit<Oven, 'hasPrivateKey' | 'hasPassphrase' | 'hasPublicKey'> {
  privateKeyRef?: string
  passphraseRef?: string
  publicKeyRef?: string
}
interface OvenRegistryFile {
  version: 1
  ovens: StoredOven[]
  defaultOvenId: string
}
const REGISTRY_PATH = 'ovens/registry.json'
const tails = new WeakMap<StorageEngine, Promise<unknown>>()

export class OvenRegistry {
  constructor(
    readonly storage: StorageEngine,
    readonly vault: SecretVault
  ) {}

  async state(): Promise<OvenState> {
    const stored = await this.read()
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
          createdAt: 0,
          updatedAt: 0
        },
        ...stored.ovens.map((oven) => this.present(oven))
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
        createdAt: existing?.createdAt ?? Date.now(),
        updatedAt: Date.now()
      }
      // Fresh refs allow rollback without destroying the last working credential.
      const added: string[] = []
      try {
        for (const [field, refField] of [
          ['privateKey', 'privateKeyRef'],
          ['passphrase', 'passphraseRef'],
          ['publicKey', 'publicKeyRef']
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
        registry.ovens = [...registry.ovens.filter((item) => item.id !== oven.id), oven]
        await this.storage.write(REGISTRY_PATH, registry)
      } catch (error) {
        for (const ref of added) await this.vault.remove(ref)
        throw error
      }
      // Old secrets can now be discarded. They never appear in renderer responses.
      for (const field of ['privateKeyRef', 'passphraseRef', 'publicKeyRef'] as const) {
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

  async remove(id: string): Promise<OvenState> {
    await this.mutate(async (registry) => {
      if (id === LOCAL_OVEN_ID) throw new Error('The Local Oven cannot be removed.')
      const oven = registry.ovens.find((item) => item.id === id)
      if (!oven) return
      registry.ovens = registry.ovens.filter((item) => item.id !== id)
      if (registry.defaultOvenId === id) registry.defaultOvenId = LOCAL_OVEN_ID
      await this.storage.write(REGISTRY_PATH, registry)
      for (const ref of [oven.privateKeyRef, oven.passphraseRef, oven.publicKeyRef]) {
        if (ref) await this.vault.remove(ref)
      }
    })
    return this.state()
  }

  private present(oven: StoredOven): Oven {
    const { privateKeyRef, passphraseRef, publicKeyRef, ...metadata } = oven
    return {
      ...metadata,
      hasPrivateKey: Boolean(privateKeyRef),
      hasPassphrase: Boolean(passphraseRef),
      hasPublicKey: Boolean(publicKeyRef)
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
    const current = previous.catch(() => undefined).then(async () => operation(await this.read()))
    tails.set(this.storage, current)
    return current
  }
}
