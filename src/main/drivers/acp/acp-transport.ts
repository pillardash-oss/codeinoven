import { buildProcessEnvironmentAsync } from '../cli-environment'
import { AcpClient } from './acp-client'
import type { AcpAgent } from '../../../lib/acp'
import {
  acpRecord,
  acpString,
  type AcpAgentCapabilities,
  type AcpContentBlock,
  type AcpInitializeResult,
  type AcpMcpServer,
  type AcpNewSessionResult
} from './acp-protocol'

/** ACP revision this client speaks. Agents answer with their own; a mismatch is reported. */
export const ACP_PROTOCOL_VERSION = 1

export interface AcpTransportHandlers {
  /** The configured agent, read at spawn time so an edit applies to the next turn. */
  resolveConfig: () => Promise<AcpAgent | null>
  /** One agent notification (`session/update` and friends). */
  notification: (method: string, params: unknown) => void
  /** One agent request (`session/request_permission`, `fs/*`, `terminal/*`). */
  request: (method: string, params: unknown) => Promise<unknown>
  /** The agent process ended. */
  exit: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void
  /** CodeInOven's own version, reported as `clientInfo.version`. */
  clientVersion?: string
}

/** Fallback client version when the caller passes none (tests, early boot). */
const FALLBACK_CLIENT_VERSION = '0.0.0'

/**
 * One ACP agent process for one project.
 *
 * The agent is a long-lived JSON-RPC peer that hosts many sessions, so the
 * process is shared by every thread in the project and only torn down on
 * dispose, restart or a dead process. `initialize` runs once per process.
 */
export class AcpTransport {
  private client: AcpClient | null = null
  private starting: Promise<AcpInitializeResult> | null = null
  private capabilities: AcpAgentCapabilities | null = null

  constructor(
    readonly projectPath: string,
    private readonly handlers: AcpTransportHandlers
  ) {}

  get pid(): number | undefined {
    return this.client?.pid
  }

  get diagnostics(): string {
    return this.client?.diagnostics ?? ''
  }

  get agentCapabilities(): AcpAgentCapabilities | null {
    return this.capabilities
  }

  /** Spawn and handshake, or reuse the running agent. */
  async initialize(): Promise<AcpInitializeResult> {
    if (this.starting) return this.starting
    this.starting = this.handshake()
    try {
      return await this.starting
    } catch (error) {
      this.starting = null
      throw error
    }
  }

  /** Open a session in the project directory and report what the agent exposes. */
  async newSession(mcpServers: readonly AcpMcpServer[] = []): Promise<AcpNewSessionResult> {
    await this.initialize()
    const result = acpRecord(
      await this.requireClient().request('session/new', {
        cwd: this.projectPath,
        mcpServers: [...mcpServers]
      })
    )
    const sessionId = acpString(result?.['sessionId'])
    if (!sessionId) throw new Error('The ACP agent did not return a session id')
    return {
      sessionId,
      ...(acpRecord(result?.['models'])
        ? { models: result?.['models'] as AcpNewSessionResult['models'] }
        : {}),
      ...(acpRecord(result?.['modes'])
        ? { modes: result?.['modes'] as AcpNewSessionResult['modes'] }
        : {}),
      ...(Array.isArray(result?.['configOptions'])
        ? { configOptions: result?.['configOptions'] as AcpNewSessionResult['configOptions'] }
        : {})
    }
  }

  /** Run one prompt. Resolves when the agent finishes the turn. */
  async prompt(
    sessionId: string,
    blocks: readonly AcpContentBlock[],
    timeoutMs: number
  ): Promise<unknown> {
    return this.requireClient().request('session/prompt', { sessionId, prompt: blocks }, timeoutMs)
  }

  /** Ask the agent to stop the running turn. ACP defines this as a notification. */
  cancel(sessionId: string): void {
    this.client?.notify('session/cancel', { sessionId })
  }

  /** Select the model a turn runs on. Unsupported agents ignore it. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.requireClient().request('session/set_model', { sessionId, modelId }, 30_000)
  }

  /** Resume a session the agent still holds, replaying its history as updates. */
  async loadSession(sessionId: string): Promise<void> {
    await this.requireClient().request('session/load', { sessionId }, 120_000)
  }

  /**
   * Close a session the agent no longer needs. Used for the disposable session
   * a catalog probe opens, so refreshing models does not leak conversations.
   */
  async closeSession(sessionId: string): Promise<void> {
    await this.requireClient().request('session/close', { sessionId }, 30_000)
  }

  /** Stop the agent process; the next turn spawns a fresh one. */
  stop(): void {
    this.client?.stop()
    this.client = null
    this.starting = null
    this.capabilities = null
  }

  private requireClient(): AcpClient {
    const client = this.client
    if (!client?.alive) throw new Error('The ACP agent is not running')
    return client
  }

  private async handshake(): Promise<AcpInitializeResult> {
    const config = await this.handlers.resolveConfig()
    if (!config) {
      throw new Error('This ACP agent is no longer configured. Add it again in Harnesses.')
    }
    const client = new AcpClient({
      command: config.command,
      args: config.args,
      cwd: this.projectPath,
      env: await this.spawnEnvironment(config),
      onNotification: (method, params) => this.handlers.notification(method, params),
      onRequest: (method, params) => this.handlers.request(method, params),
      onExit: (info) => {
        this.client = null
        this.starting = null
        this.capabilities = null
        this.handlers.exit(info)
      }
    })
    this.client = client
    client.start()
    const result = acpRecord(
      await client.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          auth: { terminal: false }
        },
        clientInfo: {
          name: 'CodeInOven',
          title: 'CodeInOven',
          // Some agents (cline 3.0.61 among them) reject the handshake when the
          // client reports no version, so this is always present.
          version: this.handlers.clientVersion ?? FALLBACK_CLIENT_VERSION
        }
      })
    )
    this.capabilities = acpCapabilities(result?.['agentCapabilities'])
    return {
      protocolVersion:
        typeof result?.['protocolVersion'] === 'number'
          ? (result['protocolVersion'] as number)
          : ACP_PROTOCOL_VERSION,
      agentCapabilities: this.capabilities,
      ...(acpRecord(result?.['agentInfo'])
        ? { agentInfo: result?.['agentInfo'] as AcpInitializeResult['agentInfo'] }
        : {})
    }
  }

  private async spawnEnvironment(config: AcpAgent): Promise<NodeJS.ProcessEnv> {
    const env = await buildProcessEnvironmentAsync()
    for (const [key, value] of Object.entries(config.env)) env[key] = value
    return env
  }
}

/** Read agent capabilities defensively: an older agent may report only a subset. */
function acpCapabilities(value: unknown): AcpAgentCapabilities {
  const record = acpRecord(value) ?? {}
  const prompt = acpRecord(record['promptCapabilities']) ?? {}
  return {
    loadSession: record['loadSession'] === true,
    promptCapabilities: {
      image: prompt['image'] === true,
      audio: prompt['audio'] === true,
      embeddedContext: prompt['embeddedContext'] === true
    }
  }
}
