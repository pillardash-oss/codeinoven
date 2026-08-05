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
 * MockOpenCodeAdapter — Testing adapter that simulates OpenCode responses.
 * Use for development and E2E testing without a real CLI binary.
 */
export class MockOpenCodeAdapter implements ProviderAdapter {
  id = 'opencode-mock'
  name = 'OpenCode (Mock)'
  type: 'cli' = 'cli'

  capabilities: ProviderCapabilities = {
    fileEditing: true,
    computerUse: false,
    multiFile: true,
    streaming: true,
    toolUse: true,
    planningMode: true
  }

  private sessions = new Map<string, AdapterSession>()
  private outputHandlers = new Map<string, OutputHandler[]>()
  private statusHandlers = new Map<string, StatusHandler[]>()
  private toolCallHandlers = new Map<string, ToolCallHandler[]>()

  async initialize(_config: ProviderConfig): Promise<void> {
    // No-op for mock
  }

  async dispose(): Promise<void> {
    this.sessions.clear()
  }

  async healthCheck(): Promise<ProviderStatus> {
    return 'connected'
  }

  async startSession(_config: SessionConfig): Promise<AdapterSession> {
    const id = generateId()
    const session: AdapterSession = {
      id,
      providerId: this.id,
      status: 'connected',
      createdAt: Date.now()
    }
    this.sessions.set(id, session)
    return session
  }

  async listSessions(): Promise<AdapterSession[]> {
    return Array.from(this.sessions.values())
  }

  async resumeSession(id: string): Promise<AdapterSession> {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return session
  }

  async send(sessionId: string, message: string, _context?: ContextOutput): Promise<void> {
    const handlers = this.outputHandlers.get(sessionId) ?? []

    // Simulate streaming a well-formed plan (bullets become checklist items)
    const response = [
      `## Plan: ${message}`,
      '',
      '- Analyze requirements and existing code',
      '- Design the implementation approach',
      '- Implement changes across affected files',
      '- Write tests for new functionality',
      '- Verify the build passes',
      ''
    ].join('\n')

    for (const char of response) {
      for (const handler of handlers) {
        handler(char)
      }
      await new Promise((resolve) => setTimeout(resolve, 4))
    }
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
