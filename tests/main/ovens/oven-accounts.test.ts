import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { syncOvenAccount } from '../../../src/main/ovens/oven-accounts'
import type { OvenService } from '../../../src/main/ovens/oven-service'
import type { HarnessAccountRegistry } from '../../../src/main/providers/harness-account-registry'
import type { HarnessAccount } from '../../../src/lib/types'

const account: HarnessAccount = {
  id: 'codex-account',
  harnessId: 'codex',
  providerId: 'openai',
  providerName: 'OpenAI',
  label: 'Work',
  containerKind: 'managed',
  createdAt: 1,
  updatedAt: 1
}

describe('oven account synchronization', () => {
  it('copies credentials only when portable configuration sync is disabled', async () => {
    const scratch = join(process.cwd(), '.cio/tmp')
    await mkdir(scratch, { recursive: true })
    const root = await mkdtemp(join(scratch, 'oven-account-'))
    const source = join(root, 'codex')
    await mkdir(source)
    await writeFile(join(source, 'auth.json'), '{"token":"secret"}')
    await writeFile(join(source, 'config.toml'), 'model = "gpt-5"')
    const putFile = vi.fn(async (
      _ovenId: string,
      _root: string,
      _path: string,
      _data: Buffer,
      _mode?: number
    ) => undefined)
    const workspace = vi.fn(async (_ovenId: string, input: { operation: string }) =>
      input.operation === 'read'
        ? { root: '/remote/account', data: Buffer.from('{}').toString('base64') }
        : { root: '/remote/account' }
    )
    const service = {
      probe: vi.fn(async () => ({ home: '/home/oven' })),
      workspace,
      putFile
    } as unknown as OvenService
    const registry = {
      environment: vi.fn(() => ({ CODEX_HOME: source }))
    } as unknown as HarnessAccountRegistry

    try {
      await syncOvenAccount(service, registry, 'oven-test', account, false)
      expect(putFile.mock.calls.map((call) => call[2])).toContain('auth.json')
      expect(putFile.mock.calls.map((call) => call[2])).not.toContain('config.toml')
      expect(putFile.mock.calls.every((call) => call[4] === 0o600)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
