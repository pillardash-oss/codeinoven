import { describe, expect, it } from 'vitest'
import {
  LEAN_AGENTS,
  LEAN_AGENT_NAMES,
  leanAgentDefinition,
  leanAgentNameForMode,
  type LeanAgentMode
} from '../../src/main/opencode/opencode-agent-definitions'

/**
 * Golden coverage for the per-mode deny matrix (P2-cp1). Every lean agent must:
 * - exist for exactly the trimmed lightweight modes,
 * - allow ONLY its documented tools,
 * - explicitly deny every heavy tool it must prune from the assembled prompt.
 * No mode may grant a tool outside its documented set.
 */

/** Shorthand-allowed keys per mode (object-shaped bash/edit are scoped separately). */
const DOCUMENTED_ALLOW: Record<LeanAgentMode, string[]> = {
  'inbox-chat': ['webfetch', 'websearch', 'question'],
  'file-system-chat': ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'question'],
  ephemeral: ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'question'],
  'image-description': ['read'],
  'pr-compose': ['read', 'glob', 'grep', 'list'],
  'utility-setup': ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'question'],
  brainstorm: ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'question']
}

/** Scoped `edit` patterns per write-capable mode. */
const DOCUMENTED_EDIT_SCOPE: Partial<Record<LeanAgentMode, string>> = {
  brainstorm: '.cio/specs/*/versions/**'
}

/** Read-only git allowances for the PR compose agent (mutating git denied). */
const DOCUMENTED_BASH_SCOPES: Array<string> = [
  'git status *',
  'git diff *',
  'git log *',
  'git show *',
  'git rev-parse *',
  'git ls-files *',
  'git ls-tree *',
  'git branch --show-current',
  'git remote -v',
  'git remote show *'
]

const HEAVY_KEYS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'todowrite',
  'webfetch',
  'websearch',
  'skill',
  'lsp',
  'external_directory',
  'question'
] as const

function agentName(mode: LeanAgentMode): string {
  return leanAgentNameForMode(mode)
}

describe('lean agent definitions', () => {
  it('ships one primary agent per trimmed mode with the expected names', () => {
    expect(LEAN_AGENTS.map((agent) => agent.name)).toEqual([
      'cio-chat',
      'cio-chat-fs',
      'cio-eph',
      'cio-img-desc',
      'cio-pr-compose',
      'cio-utility-setup',
      'cio-brainstorm'
    ])
    expect(new Set(LEAN_AGENT_NAMES).size).toBe(LEAN_AGENTS.length)
    for (const agent of LEAN_AGENTS) {
      expect(agent.mode).toBe('primary')
      expect(agent.prompt.trim().length).toBeGreaterThan(0)
      expect(agent.description.trim().length).toBeGreaterThan(0)
    }
  })

  it.each(Object.entries(DOCUMENTED_ALLOW) as Array<[LeanAgentMode, string[]]>)(
    'pins the deny matrix for %s',
    (mode, documentedAllowed) => {
      const name = agentName(mode)
      const agent = leanAgentDefinition(name)
      if (!agent) throw new Error(`missing agent ${name}`)
      expect(agent.mode).toBe('primary')
      // Every heavy permission key is set explicitly so the harness never falls
      // through to global-config allowances for an unlisted tool.
      for (const key of HEAVY_KEYS) {
        expect(agent.permission[key], `${name}.${key}`).toBeDefined()
      }
      // Allowed keys resolve to 'allow' (shorthand) for exactly the documented
      // set; everything else must be denied.
      for (const key of HEAVY_KEYS) {
        const value = agent.permission[key]
        if (typeof value === 'string') {
          if (documentedAllowed.includes(key)) expect(value).toBe('allow')
          else expect(value).toBe('deny')
        }
      }
      // Object-shaped scoped permissions are pinned per mode.
      const editScope = DOCUMENTED_EDIT_SCOPE[mode]
      if (editScope !== undefined) {
        expect(agent.permission['edit']).toMatchObject({ '*': 'deny', [editScope]: 'allow' })
      }
      // Object-shaped bash scopes are pinned per mode: PR compose allows only
      // read-only git commands; utility-setup allows only `curl` to the app API.
      if (mode === 'pr-compose' || mode === 'utility-setup') {
        const configured = agent.permission['bash']
        expect(typeof configured === 'object' && configured !== null).toBe(true)
        const mapping = configured as Record<string, 'allow' | 'deny'>
        expect(mapping['*']).toBe('deny')
        const expectedScopes = mode === 'utility-setup' ? ['curl *'] : DOCUMENTED_BASH_SCOPES
        for (const scope of expectedScopes) expect(mapping[scope]).toBe('allow')
      } else {
        expect(agent.permission['bash']).toBe('deny')
      }
      // Nothing beyond the documented allow list leaks through as 'allow'.
      const allowedKeys = HEAVY_KEYS.filter((key) => agent.permission[key] === 'allow')
      expect([...allowedKeys].sort()).toEqual([...documentedAllowed].sort())
    }
  )

  it('maps every trimmed mode to exactly one lean agent', () => {
    const expected: Record<LeanAgentMode, string> = {
      'inbox-chat': 'cio-chat',
      'file-system-chat': 'cio-chat-fs',
      ephemeral: 'cio-eph',
      'image-description': 'cio-img-desc',
      'pr-compose': 'cio-pr-compose',
      'utility-setup': 'cio-utility-setup',
      brainstorm: 'cio-brainstorm'
    }
    for (const [mode, name] of Object.entries(expected) as Array<[LeanAgentMode, string]>) {
      expect(leanAgentNameForMode(mode)).toBe(name)
      expect(leanAgentDefinition(name)).toBeDefined()
    }
  })

  it('grants no heavy tool outside the documented set', () => {
    for (const agent of LEAN_AGENTS) {
      for (const key of HEAVY_KEYS) {
        const value = agent.permission[key]
        if (typeof value === 'string' && value === 'allow') {
          const inAnyMode = Object.values(DOCUMENTED_ALLOW).some((allowed) => allowed.includes(key))
          expect(inAnyMode, `${agent.name} allows ${key}`).toBe(true)
        }
      }
    }
  })
})
