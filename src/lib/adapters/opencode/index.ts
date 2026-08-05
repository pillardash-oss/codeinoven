import { generateId } from '../../utils'
import type {
  ProviderAdapter,
  OutputHandler,
  StatusHandler,
  ToolCallHandler
} from '../adapter.interface'
import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  SessionConfig,
  AdapterSession,
  ContextOutput
} from '../../types'

/**
 * OpenCodeAdapter — PTY-based adapter for the OpenCode CLI.
 * Spawns opencode in a node-pty process and parses structured output.
 */
export class OpenCodeAdapter implements ProviderAdapter {
  id = 'opencode'
  name = 'OpenCode'
  type: 'cli' = 'cli'

  capabilities: ProviderCapabilities = {
    fileEditing: true,
    computerUse: false,
    multiFile: true,
    streaming: true,
    toolUse: true,
    planningMode: true
  }

  private config: ProviderConfig | null = null
  private sessions = new Map<string, AdapterSession>()
  private outputHandlers = new Map<string, OutputHandler[]>()
  private statusHandlers = new Map<string, StatusHandler[]>()
  private toolCallHandlers = new Map<string, ToolCallHandler[]>()

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config
  }

  async dispose(): Promise<void> {
    this.sessions.clear()
    this.outputHandlers.clear()
    this.statusHandlers.clear()
    this.toolCallHandlers.clear()
  }

  async healthCheck(): Promise<ProviderStatus> {
    if (!this.config) return 'disconnected'
    // TODO: Check if binary exists and is executable
    return 'connected'
  }

  async startSession(config: SessionConfig): Promise<AdapterSession> {
    const id = generateId()
    const session: AdapterSession = {
      id,
      providerId: this.id,
      status: 'connected',
      createdAt: Date.now()
    }

    this.sessions.set(id, session)
    // TODO: Spawn node-pty with config.command, config.args, config.projectPath
    return session
  }

  async listSessions(): Promise<AdapterSession[]> {
    return Array.from(this.sessions.values())
  }

  async resumeSession(id: string): Promise<AdapterSession> {
    const session = this.sessions.get(id)
    if (!session) {
      throw new Error(`Session not found: ${id}`)
    }
    return session
  }

  async send(sessionId: string, message: string, _context?: ContextOutput): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    // TODO: Write message to PTY stdin
    void message
  }

  onOutput(sessionId: string, handler: OutputHandler): void {
    const handlers = this.outputHandlers.get(sessionId) ?? []
    handlers.push(handler)
    this.outputHandlers.set(sessionId, handlers)
  }

  onStatusChange(sessionId: string, handler: StatusHandler): void {
    const handlers = this.statusHandlers.get(sessionId) ?? []
    handlers.push(handler)
    this.statusHandlers.set(sessionId, handlers)
  }

  onToolCall(sessionId: string, handler: ToolCallHandler): void {
    const handlers = this.toolCallHandlers.get(sessionId) ?? []
    handlers.push(handler)
    this.toolCallHandlers.set(sessionId, handlers)
  }
}

// ─── Global accessor pattern ──────────────────────────────────────────────

let adapterInstance: OpenCodeAdapter | null = null

export function setOpenCodeAdapter(adapter: OpenCodeAdapter): void {
  adapterInstance = adapter
}

export function getOpenCodeAdapter(): OpenCodeAdapter | null {
  return adapterInstance
}

export async function startOpenCodeSession(config: SessionConfig): Promise<AdapterSession> {
  if (!adapterInstance) {
    throw new Error('OpenCode adapter not initialized')
  }
  return adapterInstance.startSession(config)
}
