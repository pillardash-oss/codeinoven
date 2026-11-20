import type { OvenUtilityMcpServer, OvenUtilityTurnUtility } from '../../../lib/oven-utility-host'
import type { ResolvedUtility, UtilityDefinition } from '../../../lib/types'
import { resolveMcpHeaders } from '../mcp-connection'
import type { TurnState } from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/**
 * The turn's catalogue as an Oven can run it.
 *
 * A turn whose harness runs on an Oven reaches its gateway on that machine, so
 * that gateway has to know what the turn may use without being able to read this
 * machine's registry, database or vault. This unit builds that snapshot: the
 * definitions the turn may search, plus, for anything the Oven could run itself,
 * the resolved server command or URL and the credential environment it needs.
 *
 * The snapshot is a *description*, never authority: the Oven's host answers only
 * routes the turn's grants allow, and anything it cannot run itself comes back
 * over the turn's relay to the app, which re-checks the grant before it runs.
 * Credentials travel because a stdio server on the Oven cannot start without
 * them; only the utilities this turn may actually reach are included, and only
 * for the environment that server reads.
 */
export class UtilityOrchestrationServiceOvenUtilities {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /**
   * Every utility this turn may reach, in the shape an Oven host executes from.
   *
   * Order is stable (the turn's eligible map, then the always-on entries) so a
   * turn that resolves its endpoint twice describes the same catalogue twice.
   */
  async snapshot(state: TurnState): Promise<OvenUtilityTurnUtility[]> {
    const entries = new Map<string, ResolvedUtility>(state.eligible)
    for (const [id, entry] of state.activated) entries.set(id, entry)
    const snapshot: OvenUtilityTurnUtility[] = []
    for (const entry of entries.values()) {
      const described = await this.describe(entry.utility)
      if (described) snapshot.push(described)
    }
    return snapshot
  }

  /**
   * One utility as the Oven sees it, or null when this machine owes it nothing.
   *
   * A utility whose work only exists in this app (the browser, the design
   * studio, the app's own artifacts) is deliberately left out: describing it
   * would invite the Oven to run something it cannot, and the host already
   * forwards those routes back here.
   */
  private async describe(utility: UtilityDefinition): Promise<OvenUtilityTurnUtility | null> {
    if (utility.kind === 'skill') {
      return {
        id: utility.id,
        kind: utility.kind,
        name: utility.name,
        description: utility.description,
        docs: utility.config.instructions
      }
    }
    if (utility.kind !== 'mcp') return null
    const server = await this.mcpServer(utility)
    if (!server) return null
    return {
      id: utility.id,
      kind: utility.kind,
      name: utility.name,
      description: utility.description,
      server
    }
  }

  /**
   * The MCP server one utility starts on the Oven, with its credentials resolved.
   *
   * The command is passed through verbatim: whether `bunx`, `npx` or an absolute
   * binary exists on that machine is the Oven's question, and a server the Oven
   * cannot start answers by having the call forwarded back here rather than by
   * failing the turn.
   */
  private async mcpServer(utility: UtilityDefinition): Promise<OvenUtilityMcpServer | null> {
    if (utility.kind !== 'mcp') return null
    const config = utility.config
    const environment = {
      ...config.environment,
      ...(await this.host.units['orchestration'].credentialEnvironment(utility))
    }
    const authorization = (await this.host.mcpOAuth?.accessToken(utility)) ?? null
    const headers = resolveMcpHeaders(config, environment, utility.credentials, authorization)
    const server: OvenUtilityMcpServer = {
      utilityId: utility.id,
      name: utility.name,
      transport: config.transport,
      env: environment
    }
    if (config.transport === 'stdio') {
      if (!config.command) return null
      return { ...server, command: config.command, ...(config.args ? { args: config.args } : {}) }
    }
    if (!config.url) return null
    return {
      ...server,
      url: config.url,
      ...(Object.keys(headers).length > 0 ? { headers } : {})
    }
  }
}
