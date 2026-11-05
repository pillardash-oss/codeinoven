/**
 * ACP agents are the user's own: any harness binary that speaks the Agent
 * Client Protocol, added through the Harnesses page. These shapes are shared
 * with the renderer, which is why they live here rather than in the main-process
 * store that persists them.
 */
export interface AcpAgent {
  /** Stable harness id for this agent, e.g. `acp-cursor-agent`. */
  id: string
  /** Name shown in the harness list and the model picker. */
  name: string
  /** Executable that starts the harness in ACP mode. */
  command: string
  /** Arguments that put the harness into ACP mode, e.g. `['--acp']`. */
  args: string[]
  /** Extra environment variables the agent needs. */
  env: Record<string, string>
  /** Icon used on light surfaces. An uploaded image or an SVG/emoji token. */
  icon?: string
  /** Icon used on dark surfaces; falls back to `icon` when unset. */
  iconDark?: string
  /**
   * Whether the agent is offered as a harness. A disabled agent keeps its record,
   * its icon and its settings but leaves every harness list, so a user can park
   * one without losing it.
   */
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** Everything the editor may set. Omitted `id` creates a new agent. */
export interface AcpAgentInput {
  id?: string
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
  icon?: string | null
  iconDark?: string | null
  enabled?: boolean
}

/** A configured agent with what the app resolved for it on this machine. */
export interface AcpAgentStatus {
  id: string
  name: string
  command: string
  args: string[]
  icon?: string
  iconDark?: string
  enabled: boolean
  /** Absolute path of the resolved binary, when it exists. */
  resolvedPath?: string
  /** Actionable reason when the configured command cannot be started. */
  detail?: string
}

/** A harness known to expose ACP, offered as a starting point in the editor. */
export interface AcpKnownAgent {
  name: string
  command: string
  args: string[]
}

/** Everything the Harnesses ACP rail needs to render. */
export interface AcpAgentSettings {
  agents: AcpAgentStatus[]
  knownAgents: AcpKnownAgent[]
}

/**
 * One sign-in method an ACP agent declares in its `initialize` answer.
 *
 * ACP carries its own authentication: the agent names the methods it accepts
 * (`cursor_login`, an API-key method, a terminal login) and the client asks the
 * agent to run the one the user picked. That is why an ACP harness has no login
 * command for CodeInOven to guess, and why the app offers what the agent itself
 * declares instead of a provider list of its own.
 */
export interface AcpAuthMethod {
  id: string
  name: string
  description?: string
}

/** Sign-in state of one configured ACP agent, answered by the agent over ACP. */
export interface AcpAgentAuthStatus {
  state: 'authenticated' | 'unauthenticated' | 'unknown'
  /** Methods the agent says it accepts, even while already signed in. */
  methods: AcpAuthMethod[]
  /** What the agent said when it refused a session, or why the probe failed. */
  detail?: string
}

/** Icon formats an ACP agent accepts, matching the custom vendor icon rules. */
export const ACP_AGENT_ICON_TYPES = [
  'image/svg+xml',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]

/** Largest icon each of the two theme variants may be. */
export const MAX_ACP_AGENT_ICON_BYTES = 256 * 1024
