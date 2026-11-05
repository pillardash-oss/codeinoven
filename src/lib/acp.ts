/**
 * The user's own ACP agent: any harness binary that speaks the Agent Client
 * Protocol. These shapes are shared with the renderer, which is why they live
 * here rather than in the main-process service that persists them.
 */
export interface AcpAgentConfigInput {
  /** Display name shown in the harness picker. */
  name?: string
  /** Executable that starts the harness in ACP mode. */
  command?: string
  /** Arguments that put the harness into ACP mode, e.g. `['--acp']`. */
  args?: string[]
  /** Extra environment variables the agent needs. */
  env?: Record<string, string>
}

/** What the app resolved for the configured agent. */
export interface AcpAgentStatus {
  configured: boolean
  name: string
  command: string
  args: string[]
  /** Absolute path of the resolved binary, when it exists. */
  resolvedPath?: string
  /** Actionable reason when the configured command cannot be started. */
  detail?: string
}

/** A harness known to expose ACP, offered as a starting point in the form. */
export interface AcpKnownAgent {
  name: string
  command: string
  args: string[]
}

/** Everything the harness settings surface needs to render the ACP row. */
export interface AcpAgentSettings {
  status: AcpAgentStatus
  knownAgents: AcpKnownAgent[]
}
