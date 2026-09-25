import {
  LEAN_AGENTS,
  LEAN_AGENT_NAMES,
  type AgentPermissionValue,
  type LeanOpenCodeAgent
} from '../../opencode/opencode-agent-definitions'
import { OPENCODE_V2_RESTRICTABLE_TOOL_ACTIONS, type OpenCodeV2PermissionRule } from './v2-prompt'

/** One agent as V2's config schema (`Config.AgentEncoded`) expresses it. */
export interface OpenCodeV2AgentConfig {
  description: string
  mode: 'primary' | 'subagent' | 'all'
  system: string
  permissions: OpenCodeV2PermissionRule[]
}

/**
 * Turn OpenCode's object-form permission map into V2's rule array.
 *
 * Both dialects evaluate rules by pattern match with the LAST matching rule
 * winning (and both are written catch-all first), so the mapping preserves the
 * declared order: a scoped entry (`bash: {'*': deny, 'curl *': allow}`) becomes
 * one rule per resource, in the same order as its keys.
 *
 * Two V1 constructs cannot be carried over verbatim, because V2 applies the same
 * ruleset to its own internal actions and a blanket restriction breaks the
 * turn (verified live against `opencode v2.0.14`: a `*: deny` or `read: deny`
 * rule makes every turn fail with `provider.auth` 403):
 *
 *  - a `*` catch-all deny becomes explicit denies over every restrictable tool
 *    action, which is what the lean agents actually mean by it;
 *  - a `read` deny is dropped   reads cannot be restricted without breaking the
 *    harness, so a lean agent that asked for no reads gets the read tools back.
 *
 * Everything that mutates stays denied, which is what the lean agents exist for.
 */
export function permissionMapToRuleset(
  permission: Record<string, AgentPermissionValue>
): OpenCodeV2PermissionRule[] {
  const rules: OpenCodeV2PermissionRule[] = []
  const entries = Object.entries(permission)
  const catchAllDeny = entries.some(([action, value]) => action === '*' && value === 'deny')
  if (catchAllDeny) {
    for (const action of OPENCODE_V2_RESTRICTABLE_TOOL_ACTIONS) {
      rules.push({ action, resource: '*', effect: 'deny' })
    }
  }
  for (const [action, value] of entries) {
    if (action === '*' || action === 'read') continue
    if (typeof value === 'string') {
      rules.push({ action, resource: '*', effect: value })
      continue
    }
    for (const [resource, effect] of Object.entries(value)) {
      rules.push({ action, resource, effect })
    }
  }
  return rules
}

/** Convert one app-managed lean agent into its V2 config entry. */
export function toOpenCodeV2AgentConfig(agent: LeanOpenCodeAgent): OpenCodeV2AgentConfig {
  return {
    description: agent.description,
    mode: agent.mode,
    // V1 called this `prompt`; V2 calls it `system`.
    system: agent.prompt,
    permissions: permissionMapToRuleset(agent.permission)
  }
}

/** The `agents` map V2 consumes for every app-managed lean agent. */
export function leanAgentV2ConfigMap(): Record<string, OpenCodeV2AgentConfig> {
  return Object.fromEntries(
    LEAN_AGENTS.map((agent) => [agent.name, toOpenCodeV2AgentConfig(agent)])
  )
}

export { LEAN_AGENT_NAMES }
