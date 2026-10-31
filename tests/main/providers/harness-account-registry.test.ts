import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HarnessAccountRegistry } from '../../../src/main/providers/harness-account-registry'
import { StorageEngine } from '../../../src/main/storage/storage-engine'
import type { ProviderAccountAuthEntry } from '../../../src/lib/types'

let root = ''
let registry: HarnessAccountRegistry

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cio-account-registry-'))
  const storage = new StorageEngine(root)
  await storage.initialize()
  registry = new HarnessAccountRegistry(storage)
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const twoGoConnections: ProviderAccountAuthEntry[] = [
  { id: 'cred_a', providerId: 'opencode-go', label: 'OpenCode Go', method: 'key' },
  { id: 'cred_b', providerId: 'opencode-go', label: 'OpenCode Go', method: 'key' }
]

describe('reconcileLegacy with several credentials on one provider', () => {
  it('mirrors each connection as its own row with a distinct id and label', async () => {
    const rows = await registry.reconcileLegacy('opencode', twoGoConnections)

    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)
    expect(new Set(rows.map((row) => row.label)).size).toBe(2)
    expect(rows.every((row) => row.containerKind === 'legacy-default')).toBe(true)
    expect(rows.map((row) => row.sourceId)).toEqual(['cred_a', 'cred_b'])
  })

  it('keeps the same rows across a repeated reconcile', async () => {
    const first = await registry.reconcileLegacy('opencode', twoGoConnections)
    const second = await registry.reconcileLegacy('opencode', twoGoConnections)

    expect(second.map((row) => row.id)).toEqual(first.map((row) => row.id))
    expect(second.map((row) => row.label)).toEqual(first.map((row) => row.label))
  })

  it('uses the harness-default id when the harness has a single credential', async () => {
    const rows = await registry.reconcileLegacy('codex', [
      { id: 'cred_x', providerId: 'openai', label: 'OpenAI' }
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('codex.default')
  })

  it('drops a row when its credential disappears', async () => {
    const rows = await registry.reconcileLegacy('opencode', [twoGoConnections[0]])

    expect(rows).toHaveLength(1)
    expect(rows[0].sourceId).toBe('cred_a')
  })
})

describe('reconcileLegacy mirrors the harness-active credential', () => {
  it('marks the credential OpenCode has active as the default', async () => {
    // `auth list` does not report which connection is active, so the flag comes
    // from the store; the default badge follows it so the app shows the account
    // a turn will really use, even after a switch made inside OpenCode.
    const rows = await registry.reconcileLegacy('opencode', [
      { id: 'cred_a', providerId: 'opencode-go', label: 'OpenCode Go', method: 'key' },
      { id: 'cred_b', providerId: 'opencode-go', label: 'OpenCode Go', method: 'key', active: true }
    ])

    expect(rows.find((row) => row.sourceId === 'cred_b')?.isDefault).toBe(true)
    expect(rows.find((row) => row.sourceId === 'cred_a')?.isDefault).toBeUndefined()
  })

  it('leaves the default alone for a harness without a native account store', async () => {
    const rows = await registry.reconcileLegacy('codex', [
      { id: 'cred_y', providerId: 'openai', label: 'OpenAI', active: true }
    ])

    expect(rows[0].isDefault).toBeUndefined()
  })
})

describe('resolveForProvider honours a managed account by its reserve id', () => {
  /**
   * A managed account keeps the `pending-<uuid>` id of the reserve it was
   * created from, so the id prefix says nothing about whether the account
   * still exists. Reading it as a dead placeholder made the resolver fall back
   * to the provider default, which dispatched every switched thread on the
   * account the user had just moved away from   a limit that belonged to the
   * retired account then kept arriving from the new one.
   */
  let selectedId = ''
  let retiredId = ''

  beforeAll(async () => {
    const first = await registry.prepare('pi', 'opencode-go')
    const second = await registry.prepare('pi', 'opencode-go')
    await registry.finalizePending(first.id, 'opencode-go', 'OpenCode Go', 'Go One')
    await registry.finalizePending(second.id, 'opencode-go', 'OpenCode Go', 'Go Two')
    selectedId = second.id
    retiredId = first.id
    await registry.setDefault(first.id)
  })

  it('answers with the selected account instead of the default', async () => {
    const resolved = await registry.resolveForProvider('pi', 'opencode-go', selectedId)

    expect(resolved.id).toBe(selectedId)
    expect(resolved.isDefault).toBeUndefined()
  })

  it('still answers with the default when no selection is named', async () => {
    const resolved = await registry.resolveForProvider('pi', 'opencode-go', undefined)

    expect(resolved.id).toBe(retiredId)
  })

  it('treats a reserve that never finalized as no selection', async () => {
    const dead = await registry.prepare('pi', 'opencode-go')
    const resolved = await registry.resolveForProvider('pi', 'opencode-go', dead.id)

    expect(resolved.id).toBe(retiredId)
  })

  it('knows a listed managed account is resolvable, and a dead reserve is not', async () => {
    const dead = await registry.prepare('pi', 'opencode-go')

    expect(await registry.isResolvableAccountId(selectedId)).toBe(true)
    expect(await registry.isResolvableAccountId(dead.id)).toBe(true)
    await registry.cancelPending(dead.id)
    expect(await registry.isResolvableAccountId(dead.id)).toBe(false)
    expect(await registry.isResolvableAccountId('pi.default')).toBe(true)
  })
})
