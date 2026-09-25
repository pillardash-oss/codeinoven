import { chmod, mkdir, rm, writeFile } from 'fs/promises'
import type { SecretVault } from '../storage/secret-vault'
import type { StorageEngine } from '../storage/storage-engine'
import type { UtilityRegistryService } from './utility-registry-service'
import { Logger } from '../system/logger'
import { SECRET_ENVIRONMENT_VARIABLE_PATTERN } from '../../lib/secret-request'

/** Where a thread's free-standing secrets live inside the app config root. */
const SECRET_ROOT = 'agent-secrets'
const SECRET_REGISTRY_DIRECTORY = `${SECRET_ROOT}/threads`
const SECRET_FILES_DIRECTORY = `${SECRET_ROOT}/files`
const SECRET_REGISTRY_VERSION = 1
/** A secret file is owner-only: the same rule as the vault, enforcible at write time. */
const SECRET_FILE_MODE = 0o600
const SECRET_DIRECTORY_MODE = 0o700

export interface AgentSecretStoreRequest {
  secretId: string
  environmentVariable: string
  value: string
  /** Human label shown on the card, reused as the credential label. */
  label: string
  /** Bind the value to an installed utility as its credential, when named. */
  utilityId?: string
  /** Thread the value belongs to; free-standing secrets are re-exposed per turn. */
  threadId: string
}

/**
 * One secret the app should satisfy from state the device already holds instead
 * of from a pasted value: the user answered the card with an alternative
 * instruction ("this key was supplied in another session"), so the app looks
 * the value up itself and never asks for it twice.
 */
export interface AgentSecretReuseRequest {
  secretId: string
  /** Variable the value must end up under, exactly as the target expects it. */
  environmentVariable: string
  /** Human label shown on the card, reused as the credential label. */
  label: string
  /** Thread adopting the value. */
  threadId: string
  /** Bind the reused value to an installed utility as its credential. */
  utilityId?: string
  /**
   * Names the user pointed at in their instruction, tried in order after the
   * requested one, so a value stored under another spelling is still reused.
   */
  candidateNames?: readonly string[]
}

/** Where a value the app reused instead of collecting came from. */
export type AgentSecretReuseSource = 'this-thread' | 'another-thread' | 'utility'

/** One collected secret, described without ever exposing its value to the model. */
export interface AgentStoredSecret {
  secretId: string
  /** Human label the agent gave the secret, kept for the tool result. */
  label: string
  environmentVariable: string
  /** Utility the value was attached to as a credential, when one was named. */
  boundUtilityId?: string
  /** Owner-only file the agent interpolates with `"$(cat path)"`, for plain secrets. */
  secretPath?: string
  /**
   * Set when the user's alternative instruction let the app reuse a value the
   * device already held, instead of the user pasting one.
   */
  reusedFrom?: AgentSecretReuseSource
  /**
   * Plaintext, consumed in-process by the harness transport that applies it to
   * the session environment. Never part of a tool result.
   */
  value: string
}

/** How a pending `cio_ask_secret` request ended, as the waiting tool call sees it. */
export interface AgentSecretResolution {
  /**
   * `set` when the user pasted values, `alternative` when they answered with an
   * instruction instead (and any value the device held was reused), `dismissed`
   * when they closed the card.
   */
  status: 'set' | 'alternative' | 'dismissed'
  secrets: AgentStoredSecret[]
  /** The instruction the user sent instead of a value, verbatim. */
  alternative?: string
  /** Requested names the device holds no value for, so the agent can adapt. */
  unresolved?: string[]
}

/** One durable entry of a thread's secret registry; the value stays in the vault. */
interface AgentThreadSecret {
  environmentVariable: string
  secretRef: string
  label: string
  utilityId?: string
}

interface AgentSecretRegistryFile {
  version: number
  secrets: AgentThreadSecret[]
}

/**
 * Turns a `cio_ask_secret` submission into vault-backed state and hands the
 * harness transport what it needs to expose the value without the model ever
 * seeing it.
 *
 * A secret collected for a capability is stored exactly the way the Utilities
 * page stores it: the value goes to the encrypted vault and only the reference
 * reaches the registry, so the MCP launch resolves it into the process
 * environment and it survives an app restart.
 *
 * A plain secret (the CLI / env-var case) is registered for its thread so the
 * value can be re-exposed every turn: as an environment variable for harnesses
 * the app spawns, and as an owner-only file the agent interpolates with
 * `"$(cat path)"` when it needs the value inside a shell command. The file is
 * materialized per turn and removed when the turn ends.
 */
export class AgentSecretService {
  constructor(
    private readonly vault: SecretVault,
    private readonly registry: UtilityRegistryService,
    private readonly storage: StorageEngine
  ) {}

  async store(request: AgentSecretStoreRequest): Promise<AgentStoredSecret> {
    if (!SECRET_ENVIRONMENT_VARIABLE_PATTERN.test(request.environmentVariable)) {
      throw new TypeError(`Secret environment variable is invalid: ${request.environmentVariable}`)
    }
    if (!request.value) throw new TypeError('Secret value must not be empty')
    if (request.utilityId) {
      await this.bindUtilityCredential(request)
      return {
        secretId: request.secretId,
        label: request.label,
        environmentVariable: request.environmentVariable,
        boundUtilityId: request.utilityId,
        value: request.value
      }
    }
    const secretRef = await this.registerThreadSecret(request)
    const secretPath = await this.writeSecretFile(request.threadId, request.environmentVariable, {
      secretRef,
      environmentVariable: request.environmentVariable,
      label: request.label
    })
    return {
      secretId: request.secretId,
      label: request.label,
      environmentVariable: request.environmentVariable,
      secretPath,
      value: request.value
    }
  }

  /**
   * Environment variables one thread's free-standing secrets resolve to, for the
   * harness the app launches itself. A reference that no longer resolves is
   * skipped: a stale registry entry must never fail an unrelated turn.
   */
  async secretEnvironment(threadId: string): Promise<Record<string, string>> {
    const environment: Record<string, string> = {}
    for (const secret of await this.loadThreadSecrets(threadId)) {
      try {
        environment[secret.environmentVariable] = await this.vault.resolve(secret.secretRef)
      } catch (error) {
        Logger.dev('Agent secret could not be resolved:', error)
      }
    }
    return environment
  }

  /**
   * Write this thread's owner-only secret files for the turn that is starting.
   * Nothing is written when the thread holds no free-standing secret, so a
   * thread that never asked for one pays a single small read.
   */
  async materializeSecretFiles(threadId: string): Promise<void> {
    const secrets = await this.loadThreadSecrets(threadId)
    if (secrets.length === 0) return
    await Promise.all(
      secrets.map((secret) => this.writeSecretFile(threadId, secret.environmentVariable, secret))
    )
  }

  /** Remove this thread's secret files; the vault keeps the durable values. */
  async purgeSecretFiles(threadId: string): Promise<void> {
    await rm(this.filesDirectory(threadId), { recursive: true, force: true })
  }

  /**
   * Resolve one thread's stored secret by variable name.
   *
   * Returns null instead of throwing when the thread holds no such secret, or
   * when the reference no longer resolves, so a caller looking for an optional
   * key is never handed a failure it has to interpret.
   */
  async resolveThreadSecret(threadId: string, environmentVariable: string): Promise<string | null> {
    const secret = (await this.loadThreadSecrets(threadId)).find(
      (entry) => entry.environmentVariable === environmentVariable
    )
    if (!secret) return null
    try {
      return await this.vault.resolve(secret.secretRef)
    } catch (error) {
      Logger.dev('Agent secret could not be resolved:', error)
      return null
    }
  }

  /**
   * Find the first secret stored under one variable name, across every thread
   * that ever collected a secret.
   *
   * One thread asked for a key does not mean only that thread may use it: the
   * app's own auxiliary work belongs to no single thread, so it looks here
   * before asking the user to enter the same key twice. The registry holds one
   * small file per thread that called `cio_ask_secret`, so this stays a handful
   * of tiny reads rather than a scan of every thread on the device.
   */
  async findThreadSecret(
    environmentVariable: string
  ): Promise<{ threadId: string; value: string } | null> {
    let entries: string[]
    try {
      entries = await this.storage.list(SECRET_REGISTRY_DIRECTORY)
    } catch (error) {
      Logger.dev('Agent secret registry could not be listed:', error)
      return null
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const threadId = entry.slice(0, -'.json'.length)
      if (!threadId) continue
      const value = await this.resolveThreadSecret(threadId, environmentVariable)
      if (value) return { threadId, value }
    }
    return null
  }

  /**
   * Adopt a value the device already holds for one requested secret.
   *
   * This is the path a user takes when they have no access to the value any more
   * but the app already has it: they answer the card with an instruction instead
   * of pasting, and the value is resolved, adopted by this thread and exposed
   * exactly like a pasted one (encrypted vault plus an owner-only file, or a
   * utility credential when the agent named a capability). It is always stored
   * under the name the agent asked for, because that is the spelling the target
   * expects, and returns null when nothing matches any candidate name.
   */
  async reuse(request: AgentSecretReuseRequest): Promise<AgentStoredSecret | null> {
    for (const name of this.reuseCandidateNames(request)) {
      const found = await this.findReusableSecret(request.threadId, name)
      if (!found) continue
      const stored = await this.store({
        secretId: request.secretId,
        environmentVariable: request.environmentVariable,
        value: found.value,
        label: request.label,
        threadId: request.threadId,
        ...(request.utilityId ? { utilityId: request.utilityId } : {})
      })
      return { ...stored, reusedFrom: found.source }
    }
    return null
  }

  /** The requested name first, then the names the user mentioned, deduplicated. */
  private reuseCandidateNames(request: AgentSecretReuseRequest): string[] {
    const names = [request.environmentVariable, ...(request.candidateNames ?? [])]
    return names
      .map((name) => name.trim())
      .filter(
        (name, index, all) =>
          SECRET_ENVIRONMENT_VARIABLE_PATTERN.test(name) && all.indexOf(name) === index
      )
  }

  /**
   * Resolve one variable name from state the user already stored.
   *
   * Order is most deliberate first: a value this thread already owns is exactly
   * what is being asked for, a utility credential is a value the user attached
   * to a specific capability, and another thread's secret was collected for a
   * different piece of work and is only reused because the name matches exactly.
   */
  private async findReusableSecret(
    threadId: string,
    environmentVariable: string
  ): Promise<{ value: string; source: AgentSecretReuseSource } | null> {
    const own = await this.resolveThreadSecret(threadId, environmentVariable)
    if (own) return { value: own, source: 'this-thread' }
    const utility = await this.findUtilityCredentialValue(environmentVariable)
    if (utility) return utility
    const elsewhere = await this.findThreadSecret(environmentVariable)
    return elsewhere ? { value: elsewhere.value, source: 'another-thread' } : null
  }

  /** A stored credential an installed utility reads under this exact name. */
  private async findUtilityCredentialValue(
    environmentVariable: string
  ): Promise<{ value: string; source: AgentSecretReuseSource } | null> {
    const utilities = await this.registry.list().catch((error: unknown) => {
      Logger.dev('Utility registry could not be read for a stored credential:', error)
      return null
    })
    if (!utilities) return null
    for (const utility of utilities) {
      for (const credential of utility.credentials) {
        if (credential.environmentVariable !== environmentVariable) continue
        try {
          const value = await this.vault.resolve(credential.secretRef)
          if (value) return { value, source: 'utility' }
        } catch (error) {
          Logger.dev('Utility credential could not be resolved:', error)
        }
      }
    }
    return null
  }

  /** Forget one thread's secrets entirely, including their vault entries. */
  async deleteThreadSecrets(threadId: string): Promise<void> {
    const secrets = await this.loadThreadSecrets(threadId)
    await this.purgeSecretFiles(threadId)
    await this.storage.removeRaw(this.registryPath(threadId)).catch(() => undefined)
    await Promise.all(
      secrets.map((secret) => this.vault.remove(secret.secretRef).catch(() => undefined))
    )
  }

  /**
   * Attach (or rotate) a utility credential exactly as the Utilities page does:
   * the value goes to the vault and only the reference is written to the
   * registry, so the MCP launch resolves it into the process environment.
   */
  private async bindUtilityCredential(request: AgentSecretStoreRequest): Promise<void> {
    const utilityId = request.utilityId
    if (!utilityId) throw new TypeError('A utility id is required to bind a credential')
    const utility = await this.registry.get(utilityId)
    if (!utility) throw new Error(`Utility not found: ${utilityId}`)
    // Replace a credential this secret already owns, and match the editor's
    // identity rule so the same variable never lands twice on one utility.
    const credentialId = credentialIdFor(request.environmentVariable)
    const existing = utility.credentials.find(
      (credential) =>
        credential.id === credentialId ||
        credential.environmentVariable === request.environmentVariable
    )
    const secretRef = await this.vault.save(request.value, existing?.secretRef)
    const credentials = utility.credentials.filter(
      (credential) =>
        credential.id !== credentialId &&
        credential.environmentVariable !== request.environmentVariable
    )
    credentials.push({
      id: credentialId,
      label: request.label,
      secretRef,
      required: false,
      environmentVariable: request.environmentVariable
    })
    await this.registry.update(utilityId, { credentials })
  }

  /** Record the secret for its thread, rotating the reference in place. */
  private async registerThreadSecret(request: AgentSecretStoreRequest): Promise<string> {
    const secrets = await this.loadThreadSecrets(request.threadId)
    const existing = secrets.find(
      (secret) => secret.environmentVariable === request.environmentVariable
    )
    const secretRef = await this.vault.save(request.value, existing?.secretRef)
    const remaining = secrets.filter(
      (secret) => secret.environmentVariable !== request.environmentVariable
    )
    remaining.push({
      environmentVariable: request.environmentVariable,
      secretRef,
      label: request.label
    })
    const file: AgentSecretRegistryFile = { version: SECRET_REGISTRY_VERSION, secrets: remaining }
    await this.storage.writeRaw(this.registryPath(request.threadId), JSON.stringify(file))
    return secretRef
  }

  private async writeSecretFile(
    threadId: string,
    environmentVariable: string,
    secret: AgentThreadSecret
  ): Promise<string> {
    const path = this.secretFilePath(threadId, environmentVariable)
    const value = await this.vault.resolve(secret.secretRef)
    // Idempotent, and the only place a secret file is created, so the directory
    // mode is guaranteed on the first write of a thread.
    await mkdir(this.filesDirectory(threadId), { recursive: true, mode: SECRET_DIRECTORY_MODE })
    await writeFile(path, value, { mode: SECRET_FILE_MODE })
    // A pre-existing file keeps its old mode, so enforce it on every write.
    await chmod(path, SECRET_FILE_MODE)
    return path
  }

  /** Load one thread's registry; missing or corrupt files read as empty. */
  private async loadThreadSecrets(threadId: string): Promise<AgentThreadSecret[]> {
    try {
      const raw = await this.storage.readRaw(this.registryPath(threadId))
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) return []
      const secrets = (parsed as { secrets?: unknown }).secrets
      if (!Array.isArray(secrets)) return []
      return secrets.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return []
        const record = entry as Record<string, unknown>
        const environmentVariable = record['environmentVariable']
        const secretRef = record['secretRef']
        const label = record['label']
        if (
          typeof environmentVariable !== 'string' ||
          !SECRET_ENVIRONMENT_VARIABLE_PATTERN.test(environmentVariable) ||
          typeof secretRef !== 'string' ||
          !secretRef ||
          typeof label !== 'string'
        ) {
          return []
        }
        const utilityId = record['utilityId']
        return [
          {
            environmentVariable,
            secretRef,
            label,
            ...(typeof utilityId === 'string' && utilityId ? { utilityId } : {})
          }
        ]
      })
    } catch (error) {
      Logger.dev('Agent secret registry could not be read:', error)
      return []
    }
  }

  /** Reject anything path-like before it becomes part of a file path. */
  private assertThreadId(threadId: string): void {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(threadId)) {
      throw new Error('Invalid thread id for agent secrets')
    }
  }

  private registryPath(threadId: string): string {
    this.assertThreadId(threadId)
    return `${SECRET_REGISTRY_DIRECTORY}/${threadId}.json`
  }

  private filesDirectory(threadId: string): string {
    this.assertThreadId(threadId)
    return this.storage.resolve(`${SECRET_FILES_DIRECTORY}/${threadId}`)
  }

  private secretFilePath(threadId: string, environmentVariable: string): string {
    return `${this.filesDirectory(threadId)}/${environmentVariable}`
  }
}

/** Credential id derived from the environment variable, matching the editor. */
function credentialIdFor(environmentVariable: string): string {
  const id = environmentVariable
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-|-$/gu, '')
  return id || 'agent-secret'
}
