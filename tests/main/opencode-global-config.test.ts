import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  mergeLeanAgentsGlobalConfig,
  rollbackLeanAgentsGlobalConfig
} from '../../src/main/opencode/opencode-global-config'
import type { LeanOpenCodeAgent } from '../../src/main/opencode/opencode-agent-definitions'

let sandbox: string
let configPath: string
let backupPath: string

const FIXTURE_AGENTS: readonly LeanOpenCodeAgent[] = [
  {
    name: 'cio-chat',
    description: 'Test chat agent',
    mode: 'primary',
    prompt: 'You are a web chat assistant.',
    permission: { webfetch: 'allow', websearch: 'allow' }
  },
  {
    name: 'cio-eph',
    description: 'Test ephemeral agent',
    mode: 'primary',
    prompt: 'You are a read-only assistant.',
    permission: { read: 'allow', bash: 'deny' }
  }
]

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'opencode-config-test-'))
  configPath = join(sandbox, 'opencode.json')
  backupPath = join(sandbox, 'opencode.json.cio-agents-backup')
})

afterEach(async () => {
  await rm(sandbox, { recursive: true, force: true })
})

describe('mergeLeanAgentsGlobalConfig', () => {
  it('creates the config with lean agents when the file is absent', async () => {
    const result = await mergeLeanAgentsGlobalConfig({
      configPath,
      backupPath,
      agents: FIXTURE_AGENTS
    })
    expect(result.changed).toBe(true)
    expect(result.applied).toEqual(['cio-chat', 'cio-eph'])
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    const agents = config['agent'] as Record<string, unknown>
    expect(Object.keys(agents)).toEqual(['cio-chat', 'cio-eph'])
    expect(agents['cio-chat']).toMatchObject({ name: 'cio-chat', mode: 'primary' })
  })

  it('merges additively into an existing config without clobbering other keys', async () => {
    await writeFile(
      configPath,
      JSON.stringify(
        {
          plugin: ['@sveltejs/opencode'],
          mcp: { svelte: { command: 'svelte' } },
          agent: { 'user-agent': { description: 'mine', mode: 'primary' } }
        },
        null,
        2
      ),
      'utf8'
    )
    const result = await mergeLeanAgentsGlobalConfig({
      configPath,
      backupPath,
      agents: FIXTURE_AGENTS
    })
    expect(result.changed).toBe(true)
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(config['plugin']).toEqual(['@sveltejs/opencode'])
    expect(config['mcp']).toEqual({ svelte: { command: 'svelte' } })
    const agents = config['agent'] as Record<string, unknown>
    expect(Object.keys(agents)).toEqual(['user-agent', 'cio-chat', 'cio-eph'])
    expect(agents['user-agent']).toMatchObject({ description: 'mine' })
  })

  it('is idempotent: a second run rewrites nothing and is byte-stable', async () => {
    await mergeLeanAgentsGlobalConfig({ configPath, backupPath, agents: FIXTURE_AGENTS })
    const first = await readFile(configPath, 'utf8')
    const second = await mergeLeanAgentsGlobalConfig({
      configPath,
      backupPath,
      agents: FIXTURE_AGENTS
    })
    expect(second.changed).toBe(false)
    expect(second.applied).toEqual([])
    expect(await readFile(configPath, 'utf8')).toBe(first)
  })

  it('skips JSONC configs (comments) with a warning and never rewrites them', async () => {
    const jsonc = `{
  // user comment
  "agent": { "user-agent": { "description": "mine", "mode": "primary" } },
}`
    await writeFile(configPath, jsonc, 'utf8')
    const result = await mergeLeanAgentsGlobalConfig({
      configPath,
      backupPath,
      agents: FIXTURE_AGENTS
    })
    expect(result.changed).toBe(false)
    expect(result.warning).toMatch(/not plain JSON/)
    expect(await readFile(configPath, 'utf8')).toBe(jsonc)
  })

  it('preserves a user agent whose name is not app-managed', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ agent: { review: { description: 'reviewer', mode: 'primary' } } }),
      'utf8'
    )
    await mergeLeanAgentsGlobalConfig({ configPath, backupPath, agents: FIXTURE_AGENTS })
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    const agents = config['agent'] as Record<string, unknown>
    expect(agents['review']).toMatchObject({ description: 'reviewer' })
    expect(agents['cio-chat']).toBeDefined()
  })
})

describe('rollbackLeanAgentsGlobalConfig', () => {
  it('restores the exact pre-merge config bytes from the backup', async () => {
    const original = JSON.stringify(
      { plugin: ['@sveltejs/opencode'], agent: { custom: { description: 'x', mode: 'primary' } } },
      null,
      2
    )
    await writeFile(configPath, original, 'utf8')
    await mergeLeanAgentsGlobalConfig({ configPath, backupPath, agents: FIXTURE_AGENTS })
    expect(await readFile(configPath, 'utf8')).not.toBe(original)
    const restored = await rollbackLeanAgentsGlobalConfig({ configPath, backupPath })
    expect(restored).toBe(true)
    expect(await readFile(configPath, 'utf8')).toBe(original)
  })

  it('removes app-managed agents when no backup exists, keeping other keys', async () => {
    await writeFile(
      configPath,
      JSON.stringify({ disabled_providers: ['upstage'], agent: { other: { description: 'y', mode: 'primary' } } }),
      'utf8'
    )
    const afterMerge = await mergeLeanAgentsGlobalConfig({
      configPath,
      backupPath,
      agents: FIXTURE_AGENTS
    })
    expect(afterMerge.changed).toBe(true)
    await rm(backupPath, { force: true })
    const restored = await rollbackLeanAgentsGlobalConfig({ configPath, backupPath })
    expect(restored).toBe(true)
    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>
    expect(config['disabled_providers']).toEqual(['upstage'])
    const agents = config['agent'] as Record<string, unknown>
    expect(agents['other']).toMatchObject({ description: 'y' })
    expect(agents['cio-chat']).toBeUndefined()
    expect(agents['cio-eph']).toBeUndefined()
  })
})
