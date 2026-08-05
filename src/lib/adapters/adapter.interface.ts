import type {
  ProviderCapabilities,
  ProviderConfig,
  ProviderStatus,
  SessionConfig,
  AdapterSession,
  ContextOutput
} from '../types'

export type OutputHandler = (data: string) => void
export type StatusHandler = (status: ProviderStatus) => void
export type ToolCallHandler = (toolCall: { id: string; name: string; args: Record<string, unknown> }) => void

export interface ProviderAdapter {
  id: string
  name: string
  type: 'cli' | 'api' | 'hybrid'

  // Lifecycle
  initialize(config: ProviderConfig): Promise<void>
  dispose(): Promise<void>
  healthCheck(): Promise<ProviderStatus>

  // Session management
  startSession(config: SessionConfig): Promise<AdapterSession>
  listSessions(): Promise<AdapterSession[]>
  resumeSession(id: string): Promise<AdapterSession>

  // Communication
  send(sessionId: string, message: string, context?: ContextOutput): Promise<void>
  onOutput(sessionId: string, handler: OutputHandler): void
  onStatusChange(sessionId: string, handler: StatusHandler): void
  onToolCall(sessionId: string, handler: ToolCallHandler): void

  // Capabilities declaration
  capabilities: ProviderCapabilities
}
