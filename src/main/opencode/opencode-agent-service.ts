import { Logger } from '../system/logger'
import {
  mergeLeanAgentsGlobalConfig,
  type OpenCodeGlobalConfigMergeOptions
} from './opencode-global-config'
import { openCodeVersion, recordedDenyCompliance } from './opencode-deny-probe'

/** Operator override: install agents without a recorded deny-compliance proof. */
const MERGE_OVERRIDE_ENV = 'CIO_OPCODE_MERGE_AGENTS_UNVERIFIED'

/**
 * Startup orchestration for the app-managed opencode lean agents.
 *
 * Invoked once during post-paint service boot. The merge is idempotent and
 * additive: at most one rewrite happens, later startups are byte-stable
 * no-ops, and user-owned config (plugins, MCP wiring, other agents) is never
 * clobbered. JSONC configs are skipped with a dev-only warning and the merge
 * remains appendable. Failures are non-fatal — the app must boot even when a
 * harness config is locked down or unwritable.
 *
 * The merge is GATED on a deny-compliance proof for the installed opencode
 * version (written by the gated live probe). Agents are installed only when
 * that harness has been proven to prune denied tool schemas server-side;
 * otherwise the merge is skipped with a dev-only warning. `CIO_OPCODE_MERGE_
 * AGENTS_UNVERIFIED=1` forces installation for operators who accept the risk.
 */
export async function syncOpenCodeLeanAgents(
  options: OpenCodeGlobalConfigMergeOptions = {}
): Promise<void> {
  try {
    const version = openCodeVersion()
    const forced = process.env[MERGE_OVERRIDE_ENV] === '1'
    const record = version !== null ? await recordedDenyCompliance(version) : null
    if (!forced && record?.compliant !== true) {
      Logger.dev(
        'opencode lean-agent merge skipped: installed harness is not proven deny-compliant',
        {
          opencodeVersion: version ?? 'unknown',
          recorded: record?.compliant ?? null,
          gated: true,
          overrideEnv: MERGE_OVERRIDE_ENV
        }
      )
      return
    }
    const result = await mergeLeanAgentsGlobalConfig(options)
    if (result.changed) {
      Logger.info('Merged CodeInOven lean agents into the opencode global config', {
        applied: result.applied,
        backedUp: Boolean(result.backupPath),
        complianceGate: forced ? 'overridden' : 'proven'
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
