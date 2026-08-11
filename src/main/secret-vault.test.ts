import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { SecretVault } from './secret-vault'
import { StorageEngine } from './storage-engine'
import type { CloudDeploymentProviderKind } from '../lib/types'

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

describe('SecretVault per-provider token storage', () => {
  it('stores a provider token encrypted via safeStorage under a deterministic ref', async () => {
    const ref = await vault.saveProviderToken('coolify', 'coolify-secret-token')

    expect(ref).toBe('deployment_provider_coolify')
    expect(safeStorage.encryptString).toHaveBeenCalledWith('coolify-secret-token')
    expect(await vault.hasProviderToken('coolify')).toBe(true)
    expect(await vault.resolveProviderToken('coolify')).toBe('coolify-secret-token')
  })

  it('stores distinct tokens per provider without collision', async () => {
    await vault.saveProviderToken('coolify', 'token-a')
    await vault.saveProviderToken('netlify', 'token-b')

    expect(await vault.resolveProviderToken('coolify')).toBe('token-a')
    expect(await vault.resolveProviderToken('netlify')).toBe('token-b')
  })

  it('rotates an existing provider token in place, preserving the ref', async () => {
    await vault.saveProviderToken('coolify', 'old-token')
    const first = JSON.parse(await readVaultFile())
    const firstUpdatedAt = first['deployment_provider_coolify'].updatedAt

    await new Promise((resolve) => setTimeout(resolve, 5))
    const ref = await vault.saveProviderToken('coolify', 'new-token')

    expect(ref).toBe('deployment_provider_coolify')
    expect(await vault.resolveProviderToken('coolify')).toBe('new-token')
    const rotated = JSON.parse(await readVaultFile())
    expect(rotated['deployment_provider_coolify'].createdAt).toBe(
      first['deployment_provider_coolify'].createdAt
    )
    expect(rotated['deployment_provider_coolify'].updatedAt).toBeGreaterThan(firstUpdatedAt)
  })

  it('persists only ciphertext at rest, never the plaintext token', async () => {
    const token = 'super-secret-provider-token'
    await vault.saveProviderToken('coolify', token)

    const raw = await readVaultFile()
    expect(raw).not.toContain(token)
    const store = JSON.parse(raw)
    expect(store['deployment_provider_coolify'].value).toBe(
      Buffer.from(`enc:${token}`, 'utf-8').toString('base64')
    )
  })

  it('writes nothing plaintext into a repo or project file', async () => {
    const token = 'repo-leaking-token'
    await vault.saveProviderToken('coolify', token)

    const projectTree = await listTree(projectRoot)
    for (const file of projectTree) {
      const contents = await readFile(file, 'utf8')
      expect(contents).not.toContain(token)
    }
  })

  it('removes a provider token', async () => {
    await vault.saveProviderToken('coolify', 'remove-me')
    await vault.removeProviderToken('coolify')

    expect(await vault.hasProviderToken('coolify')).toBe(false)
    await expect(vault.resolveProviderToken('coolify')).rejects.toThrow('Credential not found')
  })

  it('throws on save when the keychain is unavailable and stores no plaintext', async () => {
    safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(vault.saveProviderToken('coolify', 'should-not-persist')).rejects.toThrow(
      'Secure credential storage is unavailable'
    )
    await expect(readVaultFile()).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('throws on resolve when the keychain is unavailable', async () => {
    await vault.saveProviderToken('coolify', 'token-before-lock')
    safeStorage.isEncryptionAvailable.mockReturnValue(false)

    await expect(vault.resolveProviderToken('coolify')).rejects.toThrow(
      'Secure credential storage is unavailable'
    )
  })

  it('mirrors the GitHub token ref shape for deployment providers', async () => {
    const kinds: CloudDeploymentProviderKind[] = [
      'coolify',
      'netlify',
      'railway',
      'vercel',
      'dokploy',
      'custom'
    ]
    for (const kind of kinds) {
      const ref = await vault.saveProviderToken(kind, `token-${kind}`)
      expect(ref).toBe(`deployment_provider_${kind}`)
    }
    for (const kind of kinds) {
      expect(await vault.resolveProviderToken(kind)).toBe(`token-${kind}`)
    }
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
