import type { ResolvedUtility, UtilityDefinitionFor } from '../../../lib/types'
import { type McpClient } from '../../agents/mcp-stdio-client'
import { Logger } from '../../system/logger'
import { RemoteMcpClient } from '../utility-orchestration/remote-mcp-client'
import {
  connectMcpServer,
  mcpOAuthChallengeHeader,
  mcpSignInDeclinedFailure,
  mcpTargetLabel
} from '../mcp-connection'
import { mcpCapableUtility } from '../utility-orchestration-service'
import type { TurnState } from '../utility-orchestration-service'
import type { UtilityOrchestrationService } from '../utility-orchestration-service'

/** UtilityOrchestrationService mcp-lifecycle: one concern, moved verbatim from the composition root. */
export class UtilityOrchestrationServiceMcpLifecycle {
  constructor(private readonly host: UtilityOrchestrationService) {}

  /** Lazily connect (or reuse) the MCP client for one utility, preparing the
   *  turn-scoped CUA cursor session for computer-use utilities. Used by both
   *  activation and straight-to-usage banked invocation. */
  async ensureMcpClient(state: TurnState, resolved: ResolvedUtility): Promise<McpClient> {
    const utilityId = resolved.utility.id
    const utility = mcpCapableUtility(resolved.utility)
    const cached = state.clients.get(utilityId)
    if (cached?.usable) {
      if (
        this.host.units['orchestration'].isComputerUseUtility(resolved) &&
        !state.cuaSessionIds.has(utilityId)
      ) {
        await this.host.units['turn-runtime'].prepareComputerUseSession(state, utilityId, cached)
      }
      return cached
    }
    if (cached) {
      // The connection stopped answering (a request timed out, the child died,
      // the remote session was lost), so it is replaced instead of reused. A
      // computer-use session is forgotten with it: that session lives inside the
      // daemon the old connection was talking to, so the new connection starts
      // its own rather than naming one that no longer exists.
      state.clients.delete(utilityId)
      state.cuaSessionIds.delete(utilityId)
      await cached.close().catch(() => undefined)
    }
    const connecting =
      state.connecting.get(utilityId) ?? this.connectMcpClient(state, resolved, utility, utilityId)
    state.connecting.set(utilityId, connecting)
    try {
      const client = await connecting
      state.clients.set(utilityId, client)
      return client
    } finally {
      if (state.connecting.get(utilityId) === connecting) state.connecting.delete(utilityId)
    }
  }

  /**
   * Establish one utility's connection and leave it ready to use: claim the
   * shared Cua daemon for a computer-use run before connecting, and start the
   * turn's cursor session once it is up.
   *
   * Separate from `ensureMcpClient` so both the caller that starts a connection
   * and any caller that joins the one already in flight run the same setup.
   */
  async connectMcpClient(
    state: TurnState,
    resolved: ResolvedUtility,
    utility: UtilityDefinitionFor<'mcp'> | UtilityDefinitionFor<'computer_use'>,
    utilityId: string
  ): Promise<McpClient> {
    if (this.host.units['orchestration'].isComputerUseUtility(resolved)) {
      // The Cua daemon's authorization mode is a start-time, daemon-wide
      // property: whichever client starts the daemon fixes it for every later
      // run until the daemon stops. Claiming the tier here, before the client
      // connects, is what keeps a full_access run from leaving an
      // approval-free daemon behind and an auto_review run from silently
      // downgrading a full_access one.
      await this.host.cuaBridge.claimDaemonMode(state.request.permissionLevel, state.id)
    }
    const client = await this.mcpClient(state, utility)
    if (this.host.units['orchestration'].isComputerUseUtility(resolved)) {
      const tools = await client.listTools()
      this.host.backgroundInputTools.set(
        client,
        new Set(
          tools
            .filter((tool) => {
              const properties = tool.inputSchema?.['properties']
              if (!properties || typeof properties !== 'object' || Array.isArray(properties))
                return false
              const delivery = (properties as Record<string, unknown>)['delivery_mode']
              if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return false
              const modes = (delivery as Record<string, unknown>)['enum']
              return (
                Array.isArray(modes) && modes.includes('background') && modes.includes('foreground')
              )
            })
            .map((tool) => tool.name)
        )
      )
      try {
        await this.host.units['turn-runtime'].prepareComputerUseSession(state, utilityId, client)
      } catch (error) {
        // A failed setup must not leave an uncached transport behind on every
        // retry, or fall through to the driver's implicit cursor session.
        await client.close().catch(() => undefined)
        throw error
      }
    }
    return client
  }

  async mcpClient(
    state: TurnState,
    utility: UtilityDefinitionFor<'mcp'> | UtilityDefinitionFor<'computer_use'>
  ): Promise<McpClient> {
    if (utility.kind === 'computer_use') {
      if (!utility.config.endpoint) {
        throw new Error(`Computer-use utility "${utility.name}" requires an MCP endpoint`)
      }
      return RemoteMcpClient.connect(
        utility.config.endpoint,
        {},
        {
          name: utility.name,
          scope: 'thread',
          projectId: state.request.projectId,
          threadId: state.request.threadId
        }
      )
    }
    // One shared starter, which the Utilities connection test calls too, so a
    // server that tests green is a server this gateway can start.
    //
    // A server that refuses for lack of authorization is not a dead end: the app
    // raises its sign-in card, and a completed sign-in earns exactly one retry
    // with the grant the browser flow just stored. Nothing loops: a retry that is
    // refused again ends the connection with the refusal.
    let target: UtilityDefinitionFor<'mcp'> = utility
    for (let attempt = 0; ; attempt += 1) {
      const connection = {
        config: target.config,
        environment: await this.host.units['orchestration'].credentialEnvironment(target),
        credentials: target.credentials,
        // Resolved here, where the vault lives: an authorized server is connected
        // with the bearer its grant issued, and an expired one is renewed from its
        // refresh token before the request leaves.
        authorization: (await this.host.mcpOAuth?.accessToken(target)) ?? null,
        owner: { name: target.name, credentials: target.credentials },
        // Attribute the running server to the turn that started it, so the task
        // manager can say which thread an MCP belongs to.
        context: { projectId: state.request.projectId, threadId: state.request.threadId }
      }
      try {
        return await connectMcpServer(connection)
      } catch (error) {
        const challenge = mcpOAuthChallengeHeader(error)
        if (!challenge) throw error
        await this.noteMcpOAuthChallenge(target, challenge)
        if (attempt > 0) throw error
        const signIn = await this.signInAfterChallenge(state, target)
        if (signIn === 'unavailable') throw error
        if (signIn === 'declined') throw mcpSignInDeclinedFailure(connection, error)
        // Persisting a grant rewrote the utility's OAuth block, so the retry reads
        // the saved definition instead of the copy resolved before the sign-in.
        const saved = await this.host.registry.get(target.id)
        if (saved?.kind !== 'mcp') throw error
        target = saved
      }
    }
  }

  /**
   * Show the sign-in card for a server that refused for lack of authorization.
   *
   * Only a remote server this app installed can be authorized here: a local
   * server is authorized by its own environment, an uninstalled one by the
   * harness that owns it, and a device with no secure storage has nowhere to keep
   * a grant. Those cases report `unavailable`, which keeps today's refusal rather
   * than claiming a user declined something they were never shown.
   */
  private async signInAfterChallenge(
    state: TurnState,
    utility: UtilityDefinitionFor<'mcp'>
  ): Promise<'unavailable' | 'declined' | 'signed_in'> {
    const executor = this.host.mcpSignInExecutor
    const url = utility.config.url
    if (!executor || !this.host.mcpOAuth || !url || utility.config.transport === 'stdio') {
      return 'unavailable'
    }
    if (!this.host.vault.isAvailable()) return 'unavailable'
    const resolution = await executor(
      {
        utilityId: utility.id,
        name: utility.name,
        endpoint: mcpTargetLabel(utility.config),
        ...(iconHostFor(url) ? { iconHost: iconHostFor(url) } : {}),
        grantScope: utility.scope.level
      },
      {
        projectId: state.request.projectId,
        threadId: state.request.threadId,
        projectPath: state.request.projectPath,
        sessionId: state.request.sessionId,
        harnessId: state.request.harnessId
      }
    )
    return resolution.status === 'signed_in' ? 'signed_in' : 'declined'
  }

  /**
   * Remember that a server refused for lack of authorization, so the Utilities
   * page offers the browser flow instead of the user reading a bare 401 in a
   * turn's trace.
   */
  async noteMcpOAuthChallenge(utility: UtilityDefinitionFor<'mcp'>, error: unknown): Promise<void> {
    const challenge = mcpOAuthChallengeHeader(error)
    if (!challenge) return
    await this.host.mcpOAuth?.noteChallenge(utility.id, challenge).catch((cause: unknown) => {
      Logger.dev('MCP OAuth challenge could not be recorded:', cause)
    })
  }
}

/** The host a remote server's own icon is resolved from, when it has one. */
function iconHostFor(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.host.toLowerCase() || undefined
  } catch {
    return undefined
  }
}
