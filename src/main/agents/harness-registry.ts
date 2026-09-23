import type { ProviderConnectionInfo } from '../../lib/types'
import { OPENCODE_COMMAND_ALIASES } from '../../lib/opencode-version'

/** The schema version of `HarnessManifest`. Bump when behaviors are added or renamed. */
export const HARNESS_MANIFEST_SCHEMA_VERSION = 1

/** Stable behavior keys every harness manifest can declare. Extend to grow. */
export type HarnessManifestBehavior = 'loadsAgentsMd' | 'manualCompaction' | 'multipleAccounts'

/**
 * Declarative, versioned behavior manifest for one harness. This is the
 * reliable default: what the harness is known to do. Runtime observations  
 * probing the installed CLI, user confirmation in Settings   are stored by
 * `HarnessManifestService` and override these declarations without mutating
 * them, keeping reliability (declared baseline) and flexibility (confirmed
 * reality) separate.
 */
export interface HarnessManifest {
  schemaVersion: typeof HARNESS_MANIFEST_SCHEMA_VERSION
  behaviors: Record<HarnessManifestBehavior, boolean>
}

/**
 * Canonical identity of a coding harness CodeInOven can detect and drive.
 * This is the single source of truth for which harnesses exist, how they are
 * probed, and the order they appear in (model picker, providers settings
 * page). Do not duplicate harness identity elsewhere   consume `listHarnesses`.
 */
export interface HarnessDescriptor {
  id: string
  name: string
  command: string
  /**
   * Alternate command names that satisfy the SAME harness, probed alongside
   * `command`. Used where one product ships under more than one binary name
   * (OpenCode's `opencode` and its `opencode2` alias): the newest version that
   * answers wins, so a v2 install always supersedes a v1 one.
   */
  commandAliases?: readonly string[]
  versionArgs: string[]
  integration: ProviderConnectionInfo['integration']
  /** Whether this harness driver can inject custom base-URL providers. */
  supportsCustomProviders: boolean
  /**
   * Declarative behavior manifest. The declared `loadsAgentsMd` value is the
   * reliable baseline; a runtime-confirmed override (when the harness is
   * actually used) takes precedence via `HarnessManifestService`.
   */
  manifest: HarnessManifest
}

/**
 * Build the versioned manifest for a harness with the given declared behaviors.
 * Every descriptor must declare every known behavior so resolution is total.
 */
function manifest(behaviors: Record<HarnessManifestBehavior, boolean>): HarnessManifest {
  return { schemaVersion: HARNESS_MANIFEST_SCHEMA_VERSION, behaviors }
}

/** The canonical ordered harness manifest. Pi first; Cline is deliberately last. */
const HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Pi has no native AGENTS.md/CLAUDE.md instruction loading; the app-level
    // behavior prompt remains available for Engineering implementation turns.
    // Manual compaction: `compact` RPC, idle-safe.
    manifest: manifest({ loadsAgentsMd: false, manualCompaction: true, multipleAccounts: false })
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    manifest: manifest({ loadsAgentsMd: true, manualCompaction: true, multipleAccounts: false })
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Claude Code reads CLAUDE.md natively. Project behavior is supplied by
    // CodeInOven's application prompt layer rather than project AGENTS.md.
    // Manual compaction: `claude -p /compact --resume <id>` (verified live).
    manifest: manifest({ loadsAgentsMd: false, manualCompaction: true, multipleAccounts: false })
  },
  {
    // One OpenCode harness. V1 and V2 both install as `opencode` and are no
    // longer installed side by side by default (the V2 installer replaces the
    // V1 binary); a package-managed V2 install may also add the `opencode2`
    // alias. The app probes both, keeps the newest, and drives the matching
    // transport (see `opencode-installation.ts` and `opencode-harness-driver.ts`).
    // The user never picks a version.
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    commandAliases: OPENCODE_COMMAND_ALIASES,
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Both lines read AGENTS.md and implement an explicit manual compaction
    // (V1 `opencode` session command; V2 `POST /api/session/{id}/compact`).
    // Native multi-account: the credential store holds several accounts per
    // integration, and the CLI can switch which one is active
    // (`opencode auth switch <integration> <credential>`, V2 only).
    manifest: manifest({ loadsAgentsMd: true, manualCompaction: true, multipleAccounts: true })
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Cline 3.x has no non-interactive compaction entry (`/compact` as a
    // positional prompt is rejected; `--compaction` only tunes automatic
    // compaction).
    manifest: manifest({ loadsAgentsMd: true, manualCompaction: false, multipleAccounts: false })
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: false,
    // Antigravity reads AGENTS.md and GEMINI.md rule files natively.
    // `/compact` in print mode is treated as ordinary prompt text (verified live).
    manifest: manifest({ loadsAgentsMd: true, manualCompaction: false, multipleAccounts: false })
  },
  {
    id: 'muse',
    name: 'Muse Code',
    command: 'muse',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: false,
    // Muse compacts via a local summary checkpoint for its stateless transport.
    manifest: manifest({ loadsAgentsMd: true, manualCompaction: true, multipleAccounts: false })
  }
]

/** The canonical ordered harness list   the single source of truth. */
export function listHarnesses(): readonly HarnessDescriptor[] {
  return HARNESSES
}

/** Look up a harness descriptor by id. */
export function findHarness(id: string): HarnessDescriptor | undefined {
  return HARNESSES.find((harness) => harness.id === id)
}

/** The declared manifest for a harness, or the behavior-safe default when unknown. */
export function harnessManifestFor(id: string): HarnessManifest | undefined {
  return findHarness(id)?.manifest
}

/**
 * Declared (manifest) value of whether the harness CLI natively loads the
 * project's AGENTS.md into the model context by itself. This remains visible
 * as harness capability metadata, while CodeInOven's own Engineering behavior
 * comes from the application prompt layer. `HarnessManifestService` layers a
 * confirmed runtime override on top.
 */
export function harnessLoadsAgentsMd(id: string): boolean {
  return harnessManifestFor(id)?.behaviors['loadsAgentsMd'] ?? false
}

/**
 * Declared (manifest) value of whether the harness supports an explicit,
 * user-requested context compaction (the driver implements `compactSession`
 * and advertises `capabilities.compaction`). The UI gates its "Compact
 * conversation" action on this declaration so the gate cannot drift from the
 * capability again.
 */
export function harnessSupportsManualCompaction(id: string): boolean {
  return harnessManifestFor(id)?.behaviors['manualCompaction'] ?? false
}

/**
 * Declared (manifest) value of whether the harness keeps several accounts for
 * one provider in its own credential store and can switch which is active.
 * OpenCode declares this (V2's `auth switch`); the other harnesses get their
 * multiple accounts from CodeInOven's per-account credential containers
 * instead, which is a different mechanism and stays declared `false` here.
 */
export function harnessSupportsMultipleAccounts(id: string): boolean {
  return harnessManifestFor(id)?.behaviors['multipleAccounts'] ?? false
}
