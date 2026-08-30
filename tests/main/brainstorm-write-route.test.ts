import { describe, expect, it } from 'vitest'
import {
  BRAINSTORM_DOCUMENT_WRITE_TOOLS,
  brainstormDocumentWriteEnabled
} from '../../src/main/chat/chat-engine'
import { leanAgentDefinition, leanAgentNameForMode } from '../../src/main/opencode/opencode-agent-definitions'

/**
 * P3-cp4 — the brainstorm document-generation turn must dispatch through a
 * SCOPED-WRITE channel on every driver capable of one:
 *
 * - `readOnly` is false (the write channel is live),
 * - the body tool map permits `edit`,
 * - on opencode, the dispatched agent is `cio-brainstorm`, whose permission
 *   scopes `edit` to the feature versions and explicitly requested prototype
 *   directories and denies every other write path (native scoping),
 * - on any other driver that streams `permission.asked` events to the app
 *   (`interactivePermissions: true`), the write route is also enabled — the
 *   turn always runs at `auto_review`, so the same PermissionPolicy that
 *   governs every other edit already scopes the write (app-side scoping),
 * - a driver with neither channel keeps the read-only sandbox with no `edit`.
 *
 * The `brainstorm_document` structured contract remains the validation
 * authority; this test pins the DISPATCH contract only.
 */

const SCOPED_WRITE_PATH = '.cio/specs/*/versions/**'
const SCOPED_PROTOTYPE_PATH = '.cio/specs/*/prototypes/**'

describe('brainstorm scoped-write route', () => {
  it('enables the write route on opencode, and on any driver whose permission-asked events reach the app', () => {
    expect(brainstormDocumentWriteEnabled('opencode')).toBe(true)
    expect(brainstormDocumentWriteEnabled('opencode', { interactivePermissions: false } as never)).toBe(
      true
    )
    expect(
      brainstormDocumentWriteEnabled('claude-code', { interactivePermissions: true } as never)
    ).toBe(true)
    expect(brainstormDocumentWriteEnabled('codex', { interactivePermissions: true } as never)).toBe(
      true
    )
    expect(brainstormDocumentWriteEnabled('cline', { interactivePermissions: false } as never)).toBe(
      false
    )
    expect(brainstormDocumentWriteEnabled('claude-code')).toBe(false)
    expect(brainstormDocumentWriteEnabled('codex')).toBe(false)
  })

  it('permits edit in the body tool map for the write route', () => {
    expect(BRAINSTORM_DOCUMENT_WRITE_TOOLS).toContain('edit')
    // Research tools stay available alongside the scoped write.
    for (const tool of ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch']) {
      expect(BRAINSTORM_DOCUMENT_WRITE_TOOLS).toContain(tool)
    }
  })

  it('dispatches the cio-brainstorm agent whose edit is path-scoped', () => {
    const name = leanAgentNameForMode('brainstorm')
    expect(name).toBe('cio-brainstorm')
    const agent = leanAgentDefinition(name)
    if (!agent) throw new Error('missing cio-brainstorm agent')
    const edit = agent.permission['edit']
    expect(typeof edit === 'object' && edit !== null).toBe(true)
    const mapping = edit as Record<string, 'allow' | 'deny'>
    // Every path is denied except the app-owned feature document and prototype roots.
    expect(mapping['*']).toBe('deny')
    expect(mapping[SCOPED_WRITE_PATH]).toBe('allow')
    expect(mapping[SCOPED_PROTOTYPE_PATH]).toBe('allow')
    const allowedPaths = Object.entries(mapping)
      .filter(([path, action]) => path !== '*' && action === 'allow')
      .map(([path]) => path)
    expect(allowedPaths).toEqual([SCOPED_WRITE_PATH, SCOPED_PROTOTYPE_PATH])
  })

  it('keeps mutating bash denied on the brainstorm agent', () => {
    const agent = leanAgentDefinition('cio-brainstorm')
    if (!agent) throw new Error('missing cio-brainstorm agent')
    expect(agent.permission['bash']).toBe('deny')
  })
})
