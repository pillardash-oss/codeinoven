import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { providerTokenRef } from '../../src/main/secrets/secret-refs'
import { SecretsService } from '../../src/main/secrets/secrets-service'
import { VaultCiphertextUnreadableError } from '../../src/main/secrets/secret-errors'
import { StorageEngine } from '../../src/main/storage/storage-engine'
import { Logger } from '../../src/main/system/logger'

const { safeStorage, app, keyring } = vi.hoisted(() => {
  /** Set while the OS keyring refuses every decryption, which is what a record
   *  written under another key looks like from here. */
  const state = { decryptionFailure: false }
  return {
    keyring: state,
    app: {
      getName: () => 'CodeInOven',
      getVersion: () => '0.0.0-test',
      isPackaged: false
    },
    safeStorage: {
      isAsyncEncryptionAvailable: vi.fn(async () => true),
      getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
      encryptStringAsync: vi.fn(async (value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
      decryptStringAsync: vi.fn(async (buffer: Buffer) => {
        if (state.decryptionFailure) {
          throw new Error(
            'Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.'
          )
        }
        return { result: buffer.toString('utf-8').replace(/^enc:/u, ''), shouldReEncrypt: false }
      })
    }
  }
})

vi.mock('electron', () => ({ safeStorage, app }))

let configRoot: string
let projectRoot: string
let storage: StorageEngine
let vault: SecretsService

async function readVaultFile(): Promise<string> {
  return readFile(join(configRoot, 'secrets', 'vault.json'), 'utf8')
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-secret-vault-'))
  configRoot = join(root, 'config')
  projectRoot = join(root, 'project')
  await mkdir(projectRoot, { recursive: true })
  storage = new StorageEngine(configRoot)
  vault = SecretsService.for(storage)
  safeStorage.isAsyncEncryptionAvailable.mockReset()
  safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true)
  safeStorage.encryptStringAsync.mockClear()
  safeStorage.decryptStringAsync.mockClear()
  keyring.decryptionFailure = false
})

afterEach(async () => {
  await rm(join(configRoot, '..'), { recursive: true, force: true })
})

describe('SecretsService per-account token storage', () => {
  const ACCOUNT_A = 'account-1'
  const ACCOUNT_B = 'account-2'

  it('stores an account token encrypted via safeStorage under a deterministic account-scoped ref', async () => {
    const ref = await vault.save('coolify-secret-token', providerTokenRef(ACCOUNT_A))

    expect(ref).toBe(`deployment_provider_${ACCOUNT_A}`)
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith('coolify-secret-token')
    expect(await vault.exists(providerTokenRef(ACCOUNT_A))).toBe(true)
    expect(await vault.resolve(providerTokenRef(ACCOUNT_A))).toBe('coolify-secret-token')
  })

  it('isolates distinct accounts (no overwrite)', async () => {
    await vault.save('token-account-a', providerTokenRef(ACCOUNT_A))
    await vault.save('token-account-b', providerTokenRef(ACCOUNT_B))

    expect(await vault.resolve(providerTokenRef(ACCOUNT_A))).toBe('token-account-a')
    expect(await vault.resolve(providerTokenRef(ACCOUNT_B))).toBe('token-account-b')
    expect(await vault.exists(providerTokenRef(ACCOUNT_A))).toBe(true)
    expect(await vault.exists(providerTokenRef(ACCOUNT_B))).toBe(true)
  })

  it('shares one account token across projects (a global account is reused)', async () => {
    await vault.save('shared-token', providerTokenRef(ACCOUNT_A))

    // The token is keyed by account id only; any project resolving this account
    // gets the same token. There is no project dimension to collide on.
    expect(await vault.resolve(providerTokenRef(ACCOUNT_A))).toBe('shared-token')
    const raw = await readVaultFile()
    expect(raw).toContain(`deployment_provider_${ACCOUNT_A}`)
    expect(raw).not.toContain('deployment_provider_project')
  })

  it('removing one account credential never affects another account', async () => {
    await vault.save('token-account-a', providerTokenRef(ACCOUNT_A))
    await vault.save('token-account-b', providerTokenRef(ACCOUNT_B))

    await vault.remove(providerTokenRef(ACCOUNT_A))

    expect(await vault.exists(providerTokenRef(ACCOUNT_A))).toBe(false)
    await expect(vault.resolve(providerTokenRef(ACCOUNT_A))).rejects.toThrow('Credential not found')
    expect(await vault.resolve(providerTokenRef(ACCOUNT_B))).toBe('token-account-b')
  })

  it('rotates an existing account token in place, preserving the ref', async () => {
    await vault.save('old-token', providerTokenRef(ACCOUNT_A))
    const first = JSON.parse(await readVaultFile())
    const refKey = `deployment_provider_${ACCOUNT_A}`
    const firstUpdatedAt = first[refKey].updatedAt

    await new Promise((resolve) => setTimeout(resolve, 5))
    const ref = await vault.save('new-token', providerTokenRef(ACCOUNT_A))

    expect(ref).toBe(refKey)
    expect(await vault.resolve(providerTokenRef(ACCOUNT_A))).toBe('new-token')
    const rotated = JSON.parse(await readVaultFile())
    expect(rotated[refKey].createdAt).toBe(first[refKey].createdAt)
    expect(rotated[refKey].updatedAt).toBeGreaterThan(firstUpdatedAt)
  })

  it('persists only ciphertext at rest, never the plaintext token', async () => {
    const token = 'super-secret-provider-token'
    await vault.save(token, providerTokenRef(ACCOUNT_A))

    const raw = await readVaultFile()
    expect(raw).not.toContain(token)
    const store = JSON.parse(raw)
    expect(store[`deployment_provider_${ACCOUNT_A}`].value).toBe(
      Buffer.from(`enc:${token}`, 'utf-8').toString('base64')
    )
  })

  it('writes nothing plaintext into a repo or project file', async () => {
    const token = 'repo-leaking-token'
    await vault.save(token, providerTokenRef(ACCOUNT_A))

    const projectTree = await listTree(projectRoot)
    for (const file of projectTree) {
      const contents = await readFile(file, 'utf8')
      expect(contents).not.toContain(token)
    }
  })

  it('removes an account token', async () => {
    await vault.save('remove-me', providerTokenRef(ACCOUNT_A))
    await vault.remove(providerTokenRef(ACCOUNT_A))

    expect(await vault.exists(providerTokenRef(ACCOUNT_A))).toBe(false)
    await expect(vault.resolve(providerTokenRef(ACCOUNT_A))).rejects.toThrow('Credential not found')
  })

  it('throws on save when the keychain is unavailable and stores no plaintext', async () => {
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false)

    await expect(vault.save('should-not-persist', providerTokenRef(ACCOUNT_A))).rejects.toThrow(
      'Secure credential storage is unavailable'
    )
    await expect(readVaultFile()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses the Linux plaintext backend instead of writing weaker ciphertext', async () => {
    // Chromium falls back to `basic_text` with no keyring on the box, which is a
    // plaintext store: the service must report itself unavailable, not pretend.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    safeStorage.getSelectedStorageBackend.mockReturnValue('basic_text')
    try {
      await expect(vault.save('must-not-be-stored', providerTokenRef(ACCOUNT_A))).rejects.toThrow(
        'Secure credential storage is unavailable'
      )
      await expect(readVaultFile()).rejects.toMatchObject({ code: 'ENOENT' })
      expect(vault.isAvailable()).toBe(false)
    } finally {
      safeStorage.getSelectedStorageBackend.mockReturnValue('gnome_libsecret')
      if (platform) Object.defineProperty(process, 'platform', platform)
    }
  })

  it('throws on resolve when the keychain is unavailable', async () => {
    await vault.save('token-before-lock', providerTokenRef(ACCOUNT_A))
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false)

    await expect(vault.resolve(providerTokenRef(ACCOUNT_A))).rejects.toThrow(
      'Secure credential storage is unavailable'
    )
  })
})

describe('SecretsService keyring identity and failure reporting', () => {
  const REF = 'github_oauth_accounts'
  /**
   * Incidents are process-wide by label and the label carries the ref, so every
   * case below leaves its credential under a ref of its own: one left failing by
   * a case must not close itself inside the next one.
   */
  const LEGACY_REF = 'github_oauth_token'
  const FOREIGN_REF = 'stored_by_another_build'
  const UNREADABLE_REF = 'unreadable_credential'
  const RECOVERING_REF = 'recovering_credential'
  const REPAIR_REF = 'repaired_credential'
  /** What `safeStorage.encryptStringAsync` produces in this suite, base64-encoded. */
  const encode = (value: string): string => Buffer.from(`enc:${value}`, 'utf-8').toString('base64')

  /**
   * Write a record straight into the vault file, standing in for an older build
   * (no author) or another build (a different one).
   */
  async function writeVaultRecord(ref: string, record: Record<string, unknown>): Promise<void> {
    await mkdir(join(configRoot, 'secrets'), { recursive: true })
    await writeFile(
      join(configRoot, 'secrets', 'vault.json'),
      JSON.stringify({ [ref]: { createdAt: 1, updatedAt: 2, ...record } })
    )
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records which build wrote a record, so a ciphertext can name its author', async () => {
    await vault.save('token-a', REF)

    const store = JSON.parse(await readVaultFile())
    expect(store[REF].writer).toEqual({
      app: 'CodeInOven',
      version: '0.0.0-test',
      build: 'development',
      platform: process.platform
    })
  })

  it('still reads a record written before records carried an author', async () => {
    await writeVaultRecord(LEGACY_REF, { value: encode('legacy-token') })

    await expect(vault.resolve(LEGACY_REF)).resolves.toBe('legacy-token')
  })

  it('names the build that wrote a credential this launch cannot decrypt', async () => {
    vi.spyOn(Logger, 'error').mockImplementation(() => {})
    await writeVaultRecord(FOREIGN_REF, {
      value: encode('foreign-token'),
      writer: { app: 'Electron', version: '0.5.0', build: 'development', platform: 'darwin' }
    })
    keyring.decryptionFailure = true

    const failure: unknown = await vault.resolve(FOREIGN_REF).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(VaultCiphertextUnreadableError)
    expect((failure as Error).message).toContain('Electron 0.5.0')
    expect((failure as Error).message).toContain('Store the credential again')
  })

  it('reports one error for a credential it cannot decrypt, then dev-level repeats', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {})
    const devSpy = vi.spyOn(Logger, 'dev').mockImplementation(() => {})
    await vault.save('token-a', UNREADABLE_REF)
    keyring.decryptionFailure = true

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(vault.resolve(UNREADABLE_REF)).rejects.toBeInstanceOf(
        VaultCiphertextUnreadableError
      )
    }

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(UNREADABLE_REF)
    expect(devSpy).toHaveBeenCalledTimes(2)
    expect(String(devSpy.mock.calls[1]?.[0])).toContain('repeat 2')
  })

  it('closes the incident once the credential decrypts again', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {})
    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {})
    await vault.save('token-a', RECOVERING_REF)
    keyring.decryptionFailure = true
    await expect(vault.resolve(RECOVERING_REF)).rejects.toBeInstanceOf(
      VaultCiphertextUnreadableError
    )

    keyring.decryptionFailure = false
    await expect(vault.resolve(RECOVERING_REF)).resolves.toBe('token-a')

    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(infoSpy).toHaveBeenCalledTimes(1)
    expect(String(infoSpy.mock.calls[0]?.[0])).toContain('recovered')
  })

  it('closes the incident when the credential is stored again, and reports the next one at error level', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {})
    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => {})
    await vault.save('stale-token', REPAIR_REF)
    keyring.decryptionFailure = true
    await expect(vault.resolve(REPAIR_REF)).rejects.toBeInstanceOf(VaultCiphertextUnreadableError)

    // Storing the credential again is the repair the failure message names.
    await vault.save('fresh-token', REPAIR_REF)
    expect(infoSpy).toHaveBeenCalledTimes(1)

    keyring.decryptionFailure = true
    await expect(vault.resolve(REPAIR_REF)).rejects.toBeInstanceOf(VaultCiphertextUnreadableError)
    expect(errorSpy).toHaveBeenCalledTimes(2)
  })
})

async function listTree(dir: string): Promise<string[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dir)
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry)
    if ((await stat(full)).isDirectory()) {
      files.push(...(await listTree(full)))
    } else {
      files.push(full)
    }
  }
  return files
}
