import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PiAuthConfigService } from '../../../src/main/providers/pi-auth-config'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'pi-auth-config-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

function service(): PiAuthConfigService {
  return new PiAuthConfigService(join(directory, 'auth.json'))
}

describe('PiAuthConfigService', () => {
  it('stores an api-key credential in the pi auth layout', async () => {
    const auth = service()
    await auth.setApiKey('openai', 'sk-test')
    const raw = JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(raw).toEqual({ openai: { type: 'api_key', key: 'sk-test' } })
    expect(await auth.hasCredential('openai')).toBe(true)
    expect([...(await auth.credentialIds())]).toEqual(['openai'])
  })

  it('removes credentials and reports them absent afterwards', async () => {
    const auth = service()
    await auth.setApiKey('anthropic', 'sk-a')
    await auth.removeCredential('anthropic')
    expect(await auth.hasCredential('anthropic')).toBe(false)
    expect((await auth.credentialIds()).size).toBe(0)
  })

  it('recognizes oauth credentials and rejects malformed provider ids', async () => {
    const authPath = join(directory, 'auth.json')
    await writeFile(
      authPath,
      JSON.stringify({
        'github-copilot': { type: 'oauth', refresh: 'r', access: 'a', expires: Date.now() + 1000 }
      })
    )
    const auth = new PiAuthConfigService(authPath)
    expect(await auth.hasCredential('github-copilot')).toBe(true)
    expect(await auth.isOauth('github-copilot')).toBe(true)
    expect(await auth.isOauth('missing')).toBe(false)
    await expect(auth.setApiKey('../escape', 'x')).rejects.toThrow()
  })
})
