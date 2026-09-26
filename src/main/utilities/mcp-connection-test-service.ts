import type {
  AgentCapabilitySource,
  McpConnectionTestResult,
  McpConnectionTool,
  McpProbeTarget,
  NativeMcpContent,
  UtilityCredentialMetadata
} from '../../lib/types'
import type { McpTool } from '../agents/mcp-stdio-client'
import { isComputerUseUtility } from '../../lib/utility-ids'
import type { UtilityRegistryService } from './utility-registry-service'
import {
  connectMcpServer,
  credentialEnvironment,
  missingCredentialVariables,
  mcpTargetLabel,
  type McpConnectionConfig
} from './mcp-connection'

/** Tools reported back to the renderer; a server with more still reports its real count. */
const TOOL_REPORT_LIMIT = 100

export interface McpConnectionTestDependencies {
  registry: UtilityRegistryService
  /** Reads a value out of the credential vault. */
  resolveSecret: (secretRef: string) => Promise<string>
  /** Reads a harness-native MCP server from the config file it lives in. */
  readNativeMcp: (source: AgentCapabilitySource) => Promise<NativeMcpContent | null>
}

interface ProbeRequest {
  name: string
  config: McpConnectionConfig
  credentials: readonly UtilityCredentialMetadata[]
  environment: Record<string, string>
}

/**
 * Proves an MCP server is reachable by connecting to it the way a turn would,
 * completing the handshake, and listing the tools it advertises.
 *
 * This exists because an MCP server is a live connection: a saved configuration
 * says nothing about whether the command exists, the URL answers, the token is
 * accepted, or the server has anything to offer.
 */
export class McpConnectionTestService {
  constructor(private readonly dependencies: McpConnectionTestDependencies) {}

  /** Test one connection. A server that will not start is reported, never thrown. */
  async test(target: McpProbeTarget): Promise<McpConnectionTestResult> {
    try {
      if (target.kind === 'registry') return await this.testRegistryUtility(target.utilityId)
      if (target.kind === 'native') return await this.testNativeServer(target.source)
      return await this.testInlineDraft(target)
    } catch (error) {
      // Nothing reached the server: an unreadable vault, a missing utility, or a
      // configuration the app cannot even assemble. Say so instead of failing the
      // whole request, so the user still gets a reason on screen.
      return unrun(error)
    }
  }

  private async testRegistryUtility(utilityId: string): Promise<McpConnectionTestResult> {
    const utility = await this.dependencies.registry.get(utilityId)
    if (!utility) throw new Error('This utility no longer exists.')
    if (utility.kind !== 'mcp') {
      throw new Error('Only an MCP server can be tested with a connection test.')
    }
    if (isComputerUseUtility(utility)) {
      // Only the Cua-aware run path may start this one, so a bare test would
      // report a failure that says nothing about whether computer use works.
      throw new Error(
        'This connection is started for a computer-use run, so the Cua Driver status card reports its state instead.'
      )
    }
    return this.probe({
      name: utility.name,
      config: utility.config,
      credentials: utility.credentials,
      environment: await this.credentialEnvironment(utility.credentials)
    })
  }

  private async testNativeServer(source: AgentCapabilitySource): Promise<McpConnectionTestResult> {
    const content = await this.dependencies.readNativeMcp(source)
    if (!content) throw new Error('This MCP server configuration could not be read from disk.')
    // A harness-native server resolves its own credential references, so the app
    // passes the configured values through exactly as written.
    return this.probe({
      name: content.name,
      config: {
        transport: content.transport,
        command: content.command,
        args: content.args,
        url: content.url,
        environment: content.environment,
        headers: content.headers
      },
      credentials: [],
      environment: {}
    })
  }

  /**
   * Test the configuration an editor is showing. Its saved utility, if any,
   * still supplies the credentials the vault holds; a value typed into the
   * unsaved editor only ever fills a variable this test is missing.
   */
  private async testInlineDraft(
    target: Extract<McpProbeTarget, { kind: 'inline' }>
  ): Promise<McpConnectionTestResult> {
    const base = target.baseUtilityId
      ? await this.dependencies.registry.get(target.baseUtilityId)
      : null
    const credentials = base?.kind === 'mcp' ? [...base.credentials] : []
    const environment = await this.credentialEnvironment(credentials)
    for (const credential of target.credentials ?? []) {
      // An empty field is not a value: leaving the variable unset is what tells
      // the server's own error apart from a blank secret being passed in.
      if (!credential.value) continue
      environment[credential.environmentVariable] = credential.value
      // A value typed into the editor is a credential too, so a remote server
      // receives it the same way a saved one is: as a request header.
      if (
        !credentials.some((entry) => entry.environmentVariable === credential.environmentVariable)
      ) {
        credentials.push({
          id: credential.environmentVariable,
          label: credential.environmentVariable,
          secretRef: '',
          required: false,
          environmentVariable: credential.environmentVariable
        })
      }
    }
    return this.probe({
      name: base?.name ?? 'MCP server',
      config: target.config,
      credentials,
      environment
    })
  }

  private async probe(request: ProbeRequest): Promise<McpConnectionTestResult> {
    const { config, credentials, environment } = request
    const transport = config.transport
    const target = mcpTargetLabel(config)
    const startedAt = Date.now()
    try {
      // The exact starter a turn uses, so a green test means the gateway can
      // start this same server with this same environment.
      const client = await connectMcpServer({
        config,
        environment,
        credentials,
        owner: { name: request.name, credentials }
      })
      try {
        const tools = await client.listTools()
        const serverInfo = client.serverInfo ?? {}
        return {
          ok: true,
          transport,
          target,
          latencyMs: Date.now() - startedAt,
          toolCount: tools.length,
          tools: reportTools(tools),
          missingCredentials: missingCredentialVariables(credentials, environment),
          ...(serverInfo.name ? { serverName: serverInfo.name } : {}),
          ...(serverInfo.version ? { serverVersion: serverInfo.version } : {})
        }
      } finally {
        // A test must never leave the server running.
        await client.close().catch(() => undefined)
      }
    } catch (error) {
      return {
        ...unrun(error),
        transport,
        target,
        latencyMs: Date.now() - startedAt,
        error: explainRemoteFailure(error, config, credentials, environment),
        missingCredentials: missingCredentialVariables(credentials, environment)
      }
    }
  }

  private credentialEnvironment(
    credentials: readonly UtilityCredentialMetadata[]
  ): Promise<Record<string, string>> {
    return credentialEnvironment(credentials, this.dependencies.resolveSecret)
  }
}

function reportTools(tools: readonly McpTool[]): McpConnectionTool[] {
  return tools.slice(0, TOOL_REPORT_LIMIT).map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {})
  }))
}

/** A test that never reached a server: the same result shape, with nothing measured. */
function unrun(error: unknown): McpConnectionTestResult {
  return {
    ok: false,
    target: '',
    latencyMs: 0,
    tools: [],
    toolCount: 0,
    error: error instanceof Error ? error.message : String(error),
    missingCredentials: []
  }
}

/**
 * Turn a remote authentication failure into something the user can act on.
 *
 * A 401 says only that the server refused the request; whether the app even sent
 * the stored key is what the user cannot tell from that. Naming the variable
 * that reached a header, or its absence, is what separates a wrong key from a
 * credential that was never wired in.
 */
function explainRemoteFailure(
  error: unknown,
  config: McpConnectionConfig,
  credentials: readonly UtilityCredentialMetadata[],
  environment: Record<string, string>
): string {
  const message = error instanceof Error ? error.message : String(error)
  if (config.transport === 'stdio') return message
  if (!/[\s(](401|403)\)?/u.test(message)) return message
  const sent = credentials.filter(
    (credential) => credential.environmentVariable && environment[credential.environmentVariable]
  )
  if (sent.length === 0) {
    return `${message}. No stored credential reached this request: set the server's credential in Utilities and test again.`
  }
  const names = sent.map((credential) => `\`${credential.environmentVariable}\``).join(', ')
  return `${message}. The stored credential${sent.length > 1 ? 's' : ''} ${names} ${
    sent.length > 1 ? 'were' : 'was'
  } sent and the server rejected it, so the value itself is the likeliest cause.`
}
