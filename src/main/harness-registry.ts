import type { ProviderConnectionInfo } from '../lib/types'

/**
 * Canonical identity of a coding harness CodeInOven can detect and drive.
 * This is the single source of truth for which harnesses exist, how they are
 * probed, and the order they appear in (model picker, providers settings
 * page). Do not duplicate harness identity elsewhere — consume `listHarnesses`.
 */
export interface HarnessDescriptor {
  id: string
  name: string
  command: string
  versionArgs: string[]
  integration: ProviderConnectionInfo['integration']
  /** Whether this harness driver can inject custom base-URL providers. */
  supportsCustomProviders: boolean
}

/** The canonical ordered harness manifest. Cline is deliberately last. */
const HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: false
  }
]

/** The canonical ordered harness list — the single source of truth. */
export function listHarnesses(): readonly HarnessDescriptor[] {
  return HARNESSES
}

/** Look up a harness descriptor by id. */
export function findHarness(id: string): HarnessDescriptor | undefined {
  return HARNESSES.find((harness) => harness.id === id)
}
