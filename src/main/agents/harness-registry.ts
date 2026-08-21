import type { ProviderConnectionInfo } from '../../lib/types'

/** The schema version of `HarnessManifest`. Bump when behaviors are added or renamed. */
export const HARNESS_MANIFEST_SCHEMA_VERSION = 1

/** Stable behavior keys every harness manifest can declare. Extend to grow. */
export type HarnessManifestBehavior = 'loadsAgentsMd'

/**
 * Declarative, versioned behavior manifest for one harness. This is the
 * reliable default: what the harness is known to do. Runtime observations —
 * probing the installed CLI, user confirmation in Settings — are stored by
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

/** The canonical ordered harness manifest. Cline is deliberately last. */
const HARNESSES: readonly HarnessDescriptor[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    manifest: manifest({ loadsAgentsMd: true })
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    manifest: manifest({ loadsAgentsMd: true })
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
    manifest: manifest({ loadsAgentsMd: false })
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    // Pi has no native AGENTS.md/CLAUDE.md instruction loading; the app-level
    // behavior prompt remains available for Engineering implementation turns.
    manifest: manifest({ loadsAgentsMd: false })
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: true,
    manifest: manifest({ loadsAgentsMd: true })
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: false,
    // Antigravity reads AGENTS.md and GEMINI.md rule files natively.
    manifest: manifest({ loadsAgentsMd: true })
  },
  {
    id: 'muse',
    name: 'Muse Code',
    command: 'muse',
    versionArgs: ['--version'],
    integration: 'ready',
    supportsCustomProviders: false,
    // Muse's workspace-native rules and skills are disabled by the driver;
    // CodeInOven assembles the project instructions explicitly instead.
    manifest: manifest({ loadsAgentsMd: false })
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
