import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { OPENCODE_ACCOUNT_USAGE_ENDPOINT } from '../../../src/main/drivers/opencode-provider-usage'
import {
  openCodeApiKeyFromCredentialValue,
  openCodeCredentialDatabasePaths,
  readOpenCodeAccountUsage,
  readOpenCodeV2ActiveCredentialIds
} from '../../../src/main/drivers/opencode-account-usage'

/**
 * The reader resolves OpenCode's data directory from `os.homedir()`. The
 * sandbox below is installed before that module loads so the suite never reads
 * the OpenCode store of whoever runs it.
 */
const sandbox = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const { mkdtemp: createDirectory } = await import('node:fs/promises')
  const { join: joinPath } = await import('node:path')
  sandbox.home = await createDirectory(joinPath(actual.tmpdir(), 'cio-opencode-usage-'))
  return { ...actual, homedir: () => sandbox.home }
})

afterAll(async () => {
  await rm(sandbox.home, { recursive: true, force: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

interface CredentialSeed {
  integrationId: string
  value: string
  active?: number
  updatedAt?: number
}

/** Write a store with the credential table OpenCode V2 actually creates. */
function createCredentialStore(path: string, seeds: CredentialSeed[]): void {
  const database = new Database(path)
  database.exec(
    `CREATE TABLE credential (
       id TEXT PRIMARY KEY,
       integration_id TEXT NOT NULL,
       label TEXT,
       value TEXT NOT NULL,
       connector_id TEXT,
       method_id TEXT,
       active INTEGER NOT NULL DEFAULT 0,
       time_created INTEGER,
       time_updated INTEGER
     )`
  )
  const insert = database.prepare(
    `INSERT INTO credential (id, integration_id, label, value, connector_id, method_id, active, time_created, time_updated)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)`
  )
  seeds.forEach((seed, index) => {
    insert.run(
      `cred_${index}`,
      seed.integrationId,
      `label-${index}`,
      seed.value,
      seed.active ?? 0,
      seed.updatedAt ?? index,
      seed.updatedAt ?? index
    )
  })
  database.close()
}

/** The usage body OpenCode Go answers with: `{ usage: { rolling, weekly, monthly } }`. */
function usageBody(): string {
  const resetsAt = new Date(Date.now() + 60 * 60_000).toISOString()
  return JSON.stringify({
    usage: {
      rolling: { percent: 42, resetsAt },
      weekly: { percent: 10, resetsAt },
      monthly: { percent: 5, resetsAt }
    }
  })
}

describe('openCodeApiKeyFromCredentialValue', () => {
  it('reads a key credential and ignores OAuth', () => {
    expect(openCodeApiKeyFromCredentialValue('{"type":"key","key":"sk-1"}')).toBe('sk-1')
    expect(openCodeApiKeyFromCredentialValue('{"type":"oauth","access":"token"}')).toBeUndefined()
    expect(openCodeApiKeyFromCredentialValue('{"type":"key","key":""}')).toBeUndefined()
    expect(openCodeApiKeyFromCredentialValue('not json')).toBeUndefined()
    expect(openCodeApiKeyFromCredentialValue(undefined)).toBeUndefined()
  })
})

describe('openCodeCredentialDatabasePaths', () => {
  it('honors an explicit OPENCODE_DB path', async () => {
    await expect(
      openCodeCredentialDatabasePaths({ OPENCODE_DB: '/somewhere/opencode.db' })
    ).resolves.toEqual(['/somewhere/opencode.db'])
  })

  it('lists every channel in the data directory the environment points at', async () => {
    const dataHome = join(sandbox.home, 'paths-data')
    const directory = join(dataHome, 'opencode')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'opencode.db'), '')
    await writeFile(join(directory, 'opencode-next.db'), '')
    await writeFile(join(directory, 'unrelated.txt'), '')

    await expect(openCodeCredentialDatabasePaths({ XDG_DATA_HOME: dataHome })).resolves.toEqual([
      join(directory, 'opencode-next.db'),
      join(directory, 'opencode.db')
    ])
  })
})

describe('readOpenCodeV2ActiveCredentialIds', () => {
  it('reports exactly the credentials the store marks active', async () => {
    const dataHome = join(sandbox.home, 'active-ids')
    const directory = join(dataHome, 'opencode')
    await mkdir(directory, { recursive: true })
    createCredentialStore(join(directory, 'opencode.db'), [
      { integrationId: 'opencode-go', value: '{"type":"key","key":"a"}', active: 1 },
      { integrationId: 'opencode-go', value: '{"type":"key","key":"b"}', active: 0 },
      { integrationId: 'opencode', value: '{"type":"key","key":"c"}', active: 1 }
    ])

    // `auth list --format json` never says which connection is active, so the
    // store is the only source; the flag is what the account list shows.
    const active = await readOpenCodeV2ActiveCredentialIds({ XDG_DATA_HOME: dataHome })
    expect([...active].sort()).toEqual(['cred_0', 'cred_2'])
  })

  it('returns nothing when no store exists', async () => {
    await expect(
      readOpenCodeV2ActiveCredentialIds({ XDG_DATA_HOME: join(sandbox.home, 'no-store') })
    ).resolves.toEqual(new Set())
  })
})

describe('readOpenCodeAccountUsage', () => {
  it('reads a V2 key from SQLite and calls the account usage endpoint', async () => {
    const dataHome = join(sandbox.home, 'v2-data')
    const directory = join(dataHome, 'opencode')
    await mkdir(directory, { recursive: true })
    createCredentialStore(join(directory, 'opencode.db'), [
      {
        integrationId: 'opencode',
        value: JSON.stringify({ type: 'key', key: 'zen-key' }),
        active: 1,
        updatedAt: 1
      },
      {
        integrationId: 'opencode-go',
        value: JSON.stringify({ type: 'key', key: 'go-key' }),
        active: 1,
        updatedAt: 2
      }
    ])

    const fetchMock = vi.fn(async () => new Response(usageBody(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await readOpenCodeAccountUsage({ XDG_DATA_HOME: dataHome }, 'v2')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      OPENCODE_ACCOUNT_USAGE_ENDPOINT,
      expect.objectContaining({ headers: { Authorization: 'Bearer go-key' } })
    )
    expect(result?.rateLimits.map((window) => window.id)).toEqual([
      'opencode-go:rolling',
      'opencode-go:weekly',
      'opencode-go:monthly'
    ])
  })

  it('prefers the active Go credential when the store holds several', async () => {
    const dataHome = join(sandbox.home, 'v2-active')
    const directory = join(dataHome, 'opencode')
    await mkdir(directory, { recursive: true })
    createCredentialStore(join(directory, 'opencode.db'), [
      {
        integrationId: 'opencode-go',
        value: JSON.stringify({ type: 'key', key: 'stale-key' }),
        active: 0,
        updatedAt: 99
      },
      {
        integrationId: 'opencode-go',
        value: JSON.stringify({ type: 'key', key: 'active-key' }),
        active: 1,
        updatedAt: 1
      }
    ])

    const fetchMock = vi.fn(async () => new Response(usageBody(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await readOpenCodeAccountUsage({ XDG_DATA_HOME: dataHome }, 'v2')

    expect(fetchMock).toHaveBeenCalledWith(
      OPENCODE_ACCOUNT_USAGE_ENDPOINT,
      expect.objectContaining({ headers: { Authorization: 'Bearer active-key' } })
    )
  })

  it('answers from the container auth.json for V1 and never the default home', async () => {
    const dataHome = join(sandbox.home, 'v1-data')
    const directory = join(dataHome, 'opencode')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'auth.json'),
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'container-key' } })
    )
    // A default-home credential must not answer for a managed account.
    const defaultStore = join(sandbox.home, '.local', 'share', 'opencode')
    await mkdir(defaultStore, { recursive: true })
    await writeFile(
      join(defaultStore, 'auth.json'),
      JSON.stringify({ 'opencode-go': { type: 'api', key: 'default-home-key' } })
    )

    const fetchMock = vi.fn(async () => new Response(usageBody(), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await readOpenCodeAccountUsage({ XDG_DATA_HOME: dataHome }, 'v1')

    expect(fetchMock).toHaveBeenCalledWith(
      OPENCODE_ACCOUNT_USAGE_ENDPOINT,
      expect.objectContaining({ headers: { Authorization: 'Bearer container-key' } })
    )
  })

  it('reports null when the key is rejected or no store holds one', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      readOpenCodeAccountUsage({ OPENCODE_API_KEY: 'rejected' }, 'v2')
    ).resolves.toBeNull()
    await expect(
      readOpenCodeAccountUsage({ XDG_DATA_HOME: join(sandbox.home, 'empty') }, 'v2')
    ).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
