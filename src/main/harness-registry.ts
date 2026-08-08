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
  /**
   * Whether the harness CLI natively loads the project's `AGENTS.md` (and nested
   * variants) into the model context on its own. When true, the app must NOT
   * re-inject AGENTS.md into the system prompt — doing so doubles the tokens for
   * a stack-agnostic instruction file. Harnesses that only read their own
   * convention (e.g. Claude Code's `CLAUDE.md`) get AGENTS.md injected by the
   * app so every harness receives the same deterministic project rules.
   */
  loadsAgentsMd: boolean
}

/** The canonical ordered harness manifest. Cline is deliberately last. */
const HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    loadsAgentsMd: true
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    loadsAgentsMd: true
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Claude Code reads CLAUDE.md natively, not AGENTS.md — the app injects
    // AGENTS.md so the project rules reach it deterministically.
    loadsAgentsMd: false
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Pi has no native AGENTS.md/CLAUDE.md instruction loading.
    loadsAgentsMd: false
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    loadsAgentsMd: true
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: false,
    // Antigravity reads AGENTS.md and GEMINI.md rule files natively.
    loadsAgentsMd: true
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

/**
 * Whether the harness CLI natively loads the project's AGENTS.md into the model
 * context by itself. When true, the app must skip injecting AGENTS.md into the
 * system prompt so the stack-agnostic instruction file is not sent twice.
 * Unknown harnesses default to `false` so the app keeps the deterministic
 * injection guarantee for harnesses it does not yet recognize.
 */
export function harnessLoadsAgentsMd(id: string): boolean {
  return HARNESSES.find((harness) => harness.id === id)?.loadsAgentsMd ?? false
}
