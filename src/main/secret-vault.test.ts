import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { SecretVault } from './secret-vault'
import { StorageEngine } from './storage-engine'

const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf-8').replace(/^enc:/u, ''))
  }
}))

vi.mock('electron', () => ({ safeStorage }))

let configRoot: string
let projectRoot: string
let storage: StorageEngine
let vault: SecretVault

async function readVaultFile(): Promise<string> {
  return readFile(join(configRoot, 'secrets', 'vault.json'), 'utf8')
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'codeinoven-secret-vault-'))
  configRoot = join(root, 'config')
  projectRoot = join(root, 'project')
  await mkdir(projectRoot, { recursive: true })
  storage = new StorageEngine(configRoot)
  vault = new SecretVault(storage)
  safeStorage.isEncryptionAvailable.mockReset()
  safeStorage.isEncryptionAvailable.mockReturnValue(true)
  safeStorage.encryptString.mockClear()
  safeStorage.decryptString.mockClear()
})

afterEach(async () => {
  await rm(join(configRoot, '..'), { recursive: true, force: true })
})

describe('SecretVault per-account token storage', () => {
  const ACCOUNT_A = 'account-1'
  const ACCOUNT_B = 'account-2'

  it('stores an account token encrypted via safeStorage under a deterministic account-scoped ref', async () => {
    const ref = await vault.saveProviderToken(ACCOUNT_A, 'coolify-secret-token')

    expect(ref).toBe(`deployment_provider_${ACCOUNT_A}`)
    expect(safeStorage.encryptString).toHaveBeenCalledWith('coolify-secret-token')
    expect(await vault.hasProviderToken(ACCOUNT_A)).toBe(true)
    expect(await vault.resolveProviderToken(ACCOUNT_A)).toBe('coolify-secret-token')
  })

  it('isolates distinct accounts (no overwrite)', async () => {
    await vault.saveProviderToken(ACCOUNT_A, 'token-account-a')
    await vault.saveProviderToken(ACCOUNT_B, 'token-account-b')

    expect(await vault.resolveProviderToken(ACCOUNT_A)).toBe('token-account-a')
    expect(await vault.resolveProviderToken(ACCOUNT_B)).toBe('token-account-b')
    expect(await vault.hasProviderToken(ACCOUNT_A)).toBe(true)
    expect(await vault.hasProviderToken(ACCOUNT_B)).toBe(true)
  })

  it('shares one account token across projects (a global account is reused)', async () => {
    await vault.saveProviderToken(ACCOUNT_A, 'shared-token')

    // The token is keyed by account id only; any project resolving this account
    // gets the same token. There is no project dimension to collide on.
    expect(await vault.resolveProviderToken(ACCOUNT_A)).toBe('shared-token')
    const raw = await readVaultFile()
    expect(raw).toContain(`deployment_provider_${ACCOUNT_A}`)
    expect(raw).not.toContain('deployment_provider_project')
  })

  it('removing one account credential never affects another account', async () => {
    await vault.saveProviderToken(ACCOUNT_A, 'token-account-a')
    await vault.saveProviderToken(ACCOUNT_B, 'token-account-b')

    await vault.removeProviderToken(ACCOUNT_A)

    expect(await vault.hasProviderToken(ACCOUNT_A)).toBe(false)
    await expect(vault.resolveProviderToken(ACCOUNT_A)).rejects.toThrow('Credential not found')
    expect(await vault.resolveProviderToken(ACCOUNT_B)).toBe('token-account-b')
  })

  it('rotates an existing account token in place, preserving the ref', async () => {
    await vault.saveProviderToken(ACCOUNT_A, 'old-token')
    const first = JSON.parse(await readVaultFile())
    const refKey = `deployment_provider_${ACCOUNT_A}`
    const firstUpdatedAt = first[refKey].updatedAt

    await new Promise((resolve) => setTimeout(resolve, 5))
    const ref = await vault.saveProviderToken(ACCOUNT_A, 'new-token')

    expect(ref).toBe(refKey)
    expect(await vault.resolveProviderToken(ACCOUNT_A)).toBe('new-token')
    const rotated = JSON.parse(await readVaultFile())
    expect(rotated[refKey].createdAt).toBe(first[refKey].createdAt)
    expect(rotated[refKey].updatedAt).toBeGreaterThan(firstUpdatedAt)
  })

  it('persists only ciphertext at rest, never the plaintext token', async () => {
    const token = 'super-secret-provider-token'
    await vault.saveProviderToken(ACCOUNT_A, token)

    const raw = await readVaultFile()
    expect(raw).not.toContain(token)
    const store = JSON.parse(raw)
    expect(store[`deployment_provider_${ACCOUNT_A}`].value).toBe(
      Buffer.from(`enc:${token}`, 'utf-8').toString('base64')
    )
  })

  it('writes nothing plaintext into a repo or project file', async () => {
    const token = 'repo-leaking-token'
    await vault.saveProviderToken(ACCOUNT_A, token)

    const projectTree = await listTree(projectRoot)
    for (const file of projectTree) {
      const contents = await readFile(file, 'utf8')
      expect(contents).not.toContain(token)
    }
  })

  it('removes an account token', async () => {
    await vault.saveProviderToken(ACCOUNT_A, 'remove-me')
    await vault.removeProviderToken(ACCOUNT_A)

    expect(await vault.hasProviderToken(ACCOUNT_A)).toBe(false)
    await expect(vault.resolveProviderToken(ACCOUNT_A)).rejects.toThrow('Credential not found')
  })

  it('throws on save when the keychain is unavailable and stores no plaintext', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(vault.saveProviderToken(ACCOUNT_A, 'should-not-persist')).rejects.toThrow(
      'Secure credential storage is unavailable'
    )
    await expect(readVaultFile()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws on resolve when the keychain is unavailable', async () => {
    await vault.saveProviderToken(ACCOUNT_A, 'token-before-lock')
    safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(vault.resolveProviderToken(ACCOUNT_A)).rejects.toThrow(
      'Secure credential storage is unavailable'
    )
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
