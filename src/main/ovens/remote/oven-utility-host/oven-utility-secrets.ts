/**
 * The credentials one Oven was trusted with, kept the way its OS can keep them.
 *
 * A remote turn normally carries its own resolved credentials from the app, and
 * that stays true here: what a turn carries for a route wins, and it is written
 * back so a rotation reaches this machine. What this store adds is the case with
 * no app behind it — a harness or the `cio-oven` CLI starting a server this
 * machine was already trusted with — and it does so *opt-in*: off by default,
 * and every write is a no-op while it is off.
 *
 * Two files, two purposes:
 *
 * - `utility-host/secrets.json` (0600) is the whole index: whether the user
 *   enabled the store, and which utility ids it holds. It never carries a value,
 *   an env name or a header name, so it is safe to read and safe to lose.
 * - the OS vault holds one JSON bundle per utility id, written through the
 *   platform backend and read back only when a turn needs it.
 *
 * Nothing is cached across turns: a bundle is read on demand every time, so a
 * forgotten secret cannot survive in a host that is still running.
 */
import { chmod, mkdir, open, readFile, rename } from 'node:fs/promises'
import type {
  OvenUtilitySecretVault,
  OvenUtilityStoredSecret
} from '../../../../lib/oven-utility-host'
import { Logger } from '../../../system/logger'
import { ovenUtilityHostDirectory } from './oven-utility-host-state'
import {
  OVEN_UTILITY_SECRET_MAX_KEYS,
  OVEN_UTILITY_SECRET_MAX_VALUE_BYTES,
  createOvenUtilitySecretBackend,
  type SecretBackend,
  type SecretCommandRunner
} from './oven-utility-secret-backend'

/** The one file that says whether this machine keeps credentials, and which. */
export const OVEN_UTILITY_SECRETS_FILE = 'secrets.json'

/** Where a file-backed backend (macOS, Windows) keeps its ciphertext. */
export const OVEN_UTILITY_SECRET_FILES_DIRECTORY = 'secret-files'

/** The write half of the store, as the credential resolver sees it. */
export interface OvenUtilityCredentialStore {
  /** The bundle this machine holds for one utility, or null when it holds none. */
  stored(utilityId: string): Promise<OvenUtilityStoredSecret | null>
  /** Keep one utility's bundle at rest; a no-op reporting `{enabled:false}` when off. */
  remember(bundle: OvenUtilityStoredSecret): Promise<{ enabled: boolean }>
}

export interface OvenUtilitySecretsOptions {
  /** The Oven account's home; everything this store owns lives under its data root. */
  home: string
  /** The platform backend. Defaults to the one this OS offers. */
  backend?: SecretBackend
  /** Where commands run, when the default backend is used. Tests inject one. */
  runner?: SecretCommandRunner
  /** Platform facts, when the default backend is used. Tests inject them. */
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * What `secrets.json` holds: the opt-in flag, the ids it remembered, and the
 * fixed slot each id occupies in the backend.
 *
 * The slot exists so this store can be swept without enumerating a keychain:
 * every key it can ever own is `cio-slot-<n>` for n below the key cap, so a
 * disable can delete the whole namespace whether or not the index survived.
 * Without that, a lost index row left a credential in the keychain with nothing
 * left that could name it again.
 */
interface OvenUtilitySecretIndex {
  enabled: boolean
  stored: string[]
  slots: Record<string, number>
}

/** The namespace every key this store files under, swept whole on disable. */
export const OVEN_UTILITY_SECRET_KEY_PREFIX = 'cio-slot-'

/** The backend key one slot owns. */
export function ovenUtilitySecretSlotKey(slot: number): string {
  return `${OVEN_UTILITY_SECRET_KEY_PREFIX}${slot}`
}

/** The plain index of a store that was never enabled. */
function emptyIndex(): OvenUtilitySecretIndex {
  return { enabled: false, stored: [], slots: {} }
}

/** The `secrets.json` path under one Oven's data root. */
export function ovenUtilitySecretsPath(home: string): string {
  return `${ovenUtilityHostDirectory(home)}/${OVEN_UTILITY_SECRETS_FILE}`
}

/** Where a file-backed backend keeps one ciphertext per key. */
export function ovenUtilitySecretFilesDirectory(home: string): string {
  return `${ovenUtilityHostDirectory(home)}/${OVEN_UTILITY_SECRET_FILES_DIRECTORY}`
}

/** One utility's bundle as the single value a backend carries for it. */
function secretBundleValue(bundle: OvenUtilityStoredSecret): string {
  // ASCII only: PowerShell reads stdin in the machine's code page, not UTF-8.
  const value = JSON.stringify({
    env: bundle.env,
    ...(bundle.headers ? { headers: bundle.headers } : {})
  }).replace(/[\u0080-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
  if (Buffer.byteLength(value, 'utf8') > OVEN_UTILITY_SECRET_MAX_VALUE_BYTES)
    throw new Error(
      `One utility's credential bundle may carry at most ${OVEN_UTILITY_SECRET_MAX_VALUE_BYTES} bytes.`
    )
  return value
}

/** Read one stored value back into a bundle, or null when it is not one. */
function secretBundleFrom(utilityId: string, value: string): OvenUtilityStoredSecret | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const env = stringRecord(record['env'])
  const headers = stringRecord(record['headers'])
  if (!env || (headers === null && record['headers'] !== undefined)) return null
  return {
    utilityId,
    env,
    ...(headers ? { headers } : {})
  }
}

/** One record of strings, or null when it is not one. Never a partial answer. */
function stringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string' || key.includes('\0')) return null
    result[key] = entry
  }
  return result
}

/** The lowest slot this store has not claimed, or the cap when every one is used. */
function firstFreeSlot(slots: Record<string, number>): number {
  const taken = new Set(Object.values(slots))
  for (let slot = 0; slot < OVEN_UTILITY_SECRET_MAX_KEYS; slot += 1) {
    if (!taken.has(slot)) return slot
  }
  return OVEN_UTILITY_SECRET_MAX_KEYS
}

/**
 * One Oven's at-rest credential store.
 *
 * A successful probe is cached for this host's life, because it starts a helper
 * process. A failed one is asked again, because a user can install the tool or
 * unlock the store without restarting the host.
 * Whether the store is *enabled* is never cached: it is read from the file on
 * every use, so toggling it in the app takes effect on the next turn.
 */
export class OvenUtilitySecrets implements OvenUtilityCredentialStore {
  private readonly backend: SecretBackend
  private readonly home: string
  private readonly indexPath: string
  /** The probe, while it runs or once it succeeded. `null` otherwise. */
  private probe: Promise<{ available: boolean; reason?: string }> | null = null
  /** Index mutations go through here, one at a time. */
  private mutation: Promise<unknown> = Promise.resolve()

  constructor(options: OvenUtilitySecretsOptions) {
    this.home = options.home
    this.backend =
      options.backend ??
      createOvenUtilitySecretBackend({
        directory: ovenUtilitySecretFilesDirectory(options.home),
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
        ...(options.env ? { env: options.env } : {})
      })
    this.indexPath = ovenUtilitySecretsPath(options.home)
  }

  /**
   * What this machine can do with a credential it is asked to keep.
   *
   * The backend id is reported as `unavailable` when it cannot work, so a client
   * reads one field and learns which of the two questions it answered.
   */
  async status(): Promise<OvenUtilitySecretVault> {
    const [index, probe] = await Promise.all([this.index(), this.probeOnce()])
    return {
      backend: probe.available ? this.backend.id : 'unavailable',
      available: probe.available,
      // The user's decision, reported as it is: a store switched on with nothing
      // in it yet is on, and a client must not have to infer it from the count.
      enabled: index.enabled,
      ...(probe.available
        ? {}
        : {
            reason:
              probe.reason ??
              'This machine offers no credential store CodeInOven can use right now.'
          }),
      stored: index.stored
    }
  }

  /**
   * Turn at-rest storage on or off.
   *
   * Enabling is only honoured when a read and a write would work right now: a
   * store that cannot keep anything must not claim it will, so the answer is the
   * state that took effect rather than the state that was asked for.
   */
  async setEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
    return await this.mutate(async () => {
      const index = await this.index()
      // Switching off never depends on the store working.
      const effective = enabled && (await this.probeOnce()).available
      if (effective !== index.enabled) {
        await this.save({ ...index, enabled: effective })
        Logger.info(
          effective
            ? `Oven secret store enabled: this machine keeps credentials with ${this.backend.id}.`
            : 'Oven secret store disabled: this machine keeps no credential at rest.'
        )
      }
      return { enabled: effective }
    })
  }

  /**
   * Keep one utility's bundle at rest.
   *
   * While the store is off (or unavailable) nothing is written and nothing is
   * remembered, which is what makes the feature opt-in rather than silent.
   */
  async remember(bundle: OvenUtilityStoredSecret): Promise<{ enabled: boolean }> {
    const value = secretBundleValue(bundle)
    return await this.mutate(async () => {
      const index = await this.index()
      if (!index.enabled || !(await this.probeOnce()).available) return { enabled: false }
      const remembered = index.stored.includes(bundle.utilityId)
      if (!remembered && index.stored.length >= OVEN_UTILITY_SECRET_MAX_KEYS)
        throw new Error(
          `This Oven keeps at most ${OVEN_UTILITY_SECRET_MAX_KEYS} utility credentials; forget one before adding another.`
        )
      const slot = index.slots[bundle.utilityId] ?? firstFreeSlot(index.slots)
      await this.backend.write(ovenUtilitySecretSlotKey(slot), value)
      // An entry from the first release is remembered but has no slot yet.
      if (!remembered || index.slots[bundle.utilityId] === undefined)
        await this.save({
          ...index,
          stored: remembered ? index.stored : [...index.stored, bundle.utilityId],
          slots: { ...index.slots, [bundle.utilityId]: slot }
        })
      Logger.dev(`Oven secret store kept a credential bundle for \`${bundle.utilityId}\`.`)
      return { enabled: true }
    })
  }

  /** The bundle this machine holds for one utility, read fresh on every ask. */
  async stored(utilityId: string): Promise<OvenUtilityStoredSecret | null> {
    const index = await this.index()
    if (!index.enabled || !index.stored.includes(utilityId)) return null
    const probe = await this.probeOnce()
    if (!probe.available) return null
    const slot = index.slots[utilityId]
    const value =
      slot === undefined
        ? await this.backend.read(utilityId)
        : await this.backend.read(ovenUtilitySecretSlotKey(slot))
    if (value === null) return null
    const bundle = secretBundleFrom(utilityId, value)
    if (!bundle)
      Logger.error(
        `An Oven's stored credential for \`${utilityId}\` is unreadable and was ignored; the turn's own credentials are used instead.`
      )
    return bundle
  }

  /** Forget one utility's bundle, or every one. Answers how many were remembered. */
  async forget(utilityId?: string): Promise<number> {
    return await this.mutate(async () => {
      const index = await this.index()
      const forgotten =
        utilityId === undefined ? [...index.stored] : index.stored.filter((id) => id === utilityId)
      if (utilityId === undefined) {
        // With no store to reach and nothing recorded, there is nothing to sweep.
        if (forgotten.length === 0 && !(await this.probeOnce()).available) return 0
        // A disable sweeps the whole namespace, not the ids this index happens to
        // still name: a credential whose row was lost is exactly the case this
        // exists for, and it costs one delete per slot the store can ever own.
        for (let slot = 0; slot < OVEN_UTILITY_SECRET_MAX_KEYS; slot += 1)
          await this.backend.remove(ovenUtilitySecretSlotKey(slot))
        // Keys filed by the first release, under the bare utility id.
        for (const id of forgotten) await this.backend.remove(id)
        if (index.enabled || index.stored.length > 0 || Object.keys(index.slots).length > 0)
          await this.save({ ...index, stored: [], slots: {} })
      } else {
        for (const id of forgotten) {
          const slot = index.slots[id]
          if (slot !== undefined) await this.backend.remove(ovenUtilitySecretSlotKey(slot))
          await this.backend.remove(id)
        }
        const remaining = index.stored.filter((id) => id !== utilityId)
        if (remaining.length !== index.stored.length) {
          const slots = Object.fromEntries(
            Object.entries(index.slots).filter(([id]) => id !== utilityId)
          )
          await this.save({ ...index, stored: remaining, slots })
        }
      }
      if (forgotten.length > 0)
        Logger.info(
          forgotten.length === 1
            ? `Oven secret store forgot the credential for \`${forgotten[0]}\`.`
            : `Oven secret store forgot ${forgotten.length} credentials.`
        )
      return forgotten.length
    })
  }

  /** Forget every credential this machine holds. */
  async forgetAll(): Promise<void> {
    await this.forget()
  }

  /** The index as written, or a disabled empty one when there is none yet. */
  private async index(): Promise<OvenUtilitySecretIndex> {
    const text = await readFile(this.indexPath, 'utf8').catch(() => null)
    if (text === null) return emptyIndex()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return emptyIndex()
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyIndex()
    const record = parsed as Record<string, unknown>
    const stored = record['stored']
    const rawSlots = record['slots']
    const slots: Record<string, number> = {}
    if (rawSlots && typeof rawSlots === 'object' && !Array.isArray(rawSlots)) {
      for (const [id, slot] of Object.entries(rawSlots as Record<string, unknown>)) {
        if (typeof slot !== 'number' || !Number.isInteger(slot)) continue
        if (slot < 0 || slot >= OVEN_UTILITY_SECRET_MAX_KEYS) continue
        if (id.length === 0 || id.length > 200 || id.includes('\0')) continue
        slots[id] = slot
      }
    }
    return {
      enabled: record['enabled'] === true,
      slots,
      stored: Array.isArray(stored)
        ? [
            ...new Set(
              stored.filter(
                (id): id is string =>
                  typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('\0')
              )
            )
          ].slice(0, OVEN_UTILITY_SECRET_MAX_KEYS)
        : []
    }
  }

  /** Rewrite the index 0600, after the mutation that decided its new shape. */
  private async save(index: OvenUtilitySecretIndex): Promise<void> {
    await mkdir(ovenUtilityHostDirectory(this.home), { recursive: true, mode: 0o700 })
    // Readers are not queued behind writers, so the file is replaced whole: a
    // half-written one would read as a store that is switched off.
    const staged = `${this.indexPath}.${process.pid}.next`
    const file = await open(staged, 'w', 0o600)
    try {
      await file.writeFile(JSON.stringify(index))
      await file.sync()
    } finally {
      await file.close()
    }
    // `open` applies its mode only when it creates the file, so a file left
    // behind by an earlier version keeps whatever permissions it had without this.
    await chmod(staged, 0o600)
    await rename(staged, this.indexPath)
  }

  /**
   * Run one read-modify-write of the index alone.
   *
   * Remembering and forgetting both read the index, act on it, and write it
   * back. Two turns rotating at once would otherwise each write the list they
   * saw first, and one remembered id would be lost.
   */
  private mutate<T>(work: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(work)
    this.mutation = next.catch(() => undefined)
    return next
  }

  /** Ask the backend until it says yes; concurrent readers share one ask. */
  private probeOnce(): Promise<{ available: boolean; reason?: string }> {
    const cached = this.probe
    if (cached) return cached
    const probing = this.backend.probe().catch((error: unknown) => ({
      available: false,
      reason:
        error instanceof Error
          ? error.message
          : 'This machine offered no answer about its credential store.'
    }))
    this.probe = probing
    void probing.then(({ available }) => {
      if (!available) this.probe = null
    })
    return probing
  }
}
