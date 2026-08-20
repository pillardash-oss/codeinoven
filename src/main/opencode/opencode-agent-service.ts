import { Logger } from '../system/logger'
import {
  mergeLeanAgentsGlobalConfig,
  type OpenCodeGlobalConfigMergeOptions
} from './opencode-global-config'

/**
 * Startup orchestration for the app-managed opencode lean agents.
 *
 * Invoked once during post-paint service boot. The merge is idempotent and
 * additive: at most one rewrite happens, later startups are byte-stable
 * no-ops, and user-owned config (plugins, MCP wiring, other agents) is never
 * clobbered. JSONC configs are skipped with a dev-only warning and the merge
 * remains appendable. Failures are non-fatal — the app must boot even when a
 * harness config is locked down or unwritable.
 */
export async function syncOpenCodeLeanAgents(
  options: OpenCodeGlobalConfigMergeOptions = {}
): Promise<void> {
  try {
    const result = await mergeLeanAgentsGlobalConfig(options)
    if (result.changed) {
      Logger.info('Merged CodeInOven lean agents into the opencode global config', {
        applied: result.applied,
        backedUp: Boolean(result.backupPath)
      })
    } else if (result.warning) {
      Logger.dev('opencode lean-agent merge skipped', { warning: result.warning })
    }
  } catch (error) {
    Logger.dev(
      'opencode lean-agent merge failed (non-fatal; agents are optional lightweight helpers):',
      error
    )
  }
}

/** Dev-only summary helper used by diagnostics and rollback docs. */
export function describeLeanAgentSync(result: {
  changed: boolean
  applied: string[]
  warning?: string
}): string {
  if (result.warning) return `lean agents skipped: ${result.warning}`
  if (!result.changed) return 'lean agents already present (no rewrite)'
  return `lean agents merged: ${result.applied.join(', ')}`
}
