import { APP_NAME } from '../../lib/brand'

/**
 * Typed definitions for the lean, app-managed opencode custom agents.
 *
 * One agent per trimmed mode. Each agent ships a minimal prompt and an
 * explicit permission matrix that DENIES every heavy tool the mode must not
 * see, so opencode prunes those tool/skill schemas server-side on the headless
 * prompt endpoint (validated by the P1 deny-compliance probe). The `*: deny`
 * catch-all sits first; the per-key `allow` entries come after it (last-match
 * wins), guaranteeing nothing unknown leaks into the mode's assembled prompt.
 *
 * Engineering/implement modes never reference these agents — they keep the
 * full built-in opencode experience.
 */

export type PermissionAction = 'allow' | 'deny'
export type AgentPermissionValue = PermissionAction | Record<string, PermissionAction>

export interface LeanOpenCodeAgent {
  name: string
  description: string
  mode: 'primary'
  prompt: string
  permission: Record<string, AgentPermissionValue>
}

/** The lightweight modes that receive an app-managed lean agent. */
export type LeanAgentMode =
  | 'inbox-chat'
  | 'file-system-chat'
  | 'ephemeral'
  | 'image-description'
  | 'pr-compose'
  | 'utility-setup'
  | 'brainstorm'

const DENY: PermissionAction = 'deny'
const ALLOW: PermissionAction = 'allow'

/** Base deny set every lean agent starts from; allow overrides are added per mode. */
const baseDeny: Record<string, AgentPermissionValue> = {
  '*': DENY,
  read: DENY,
  edit: DENY,
  glob: DENY,
  grep: DENY,
  list: DENY,
  bash: DENY,
  task: DENY,
  webfetch: DENY,
  websearch: DENY,
  lsp: DENY,
  skill: DENY,
  todowrite: DENY,
  external_directory: DENY,
  question: DENY
}

/** Inbox chat: web research + clarifying questions only, no file-system tools. */
const chatPermission: Record<string, AgentPermissionValue> = {
  ...baseDeny,
  webfetch: ALLOW,
  websearch: ALLOW,
  question: ALLOW
}

/** File-system chat + ephemeral: read/search plus web research, never mutate. */
const readResearchPermission: Record<string, AgentPermissionValue> = {
  ...baseDeny,
  read: ALLOW,
  glob: ALLOW,
  grep: ALLOW,
  list: ALLOW,
  webfetch: ALLOW,
  websearch: ALLOW,
  question: ALLOW
}

/** Image description: describe the attached image, no tools beyond read. */
const imageDescriptionPermission: Record<string, AgentPermissionValue> = {
  ...baseDeny,
  read: ALLOW
}

/** PR compose receives app-prepared evidence and has no repository tools. */
const prComposePermission: Record<string, AgentPermissionValue> = {
  ...baseDeny
}

/** Explicit utility setup: research plus the turn-scoped loopback API, no file writes. */
const utilitySetupPermission: Record<string, AgentPermissionValue> = {
  ...readResearchPermission,
  bash: { '*': DENY, 'curl *': ALLOW }
}

/** Brainstorm: read research + web + questions, write scoped to feature versions dir. */
const brainstormPermission: Record<string, AgentPermissionValue> = {
  ...baseDeny,
  read: ALLOW,
  glob: ALLOW,
  grep: ALLOW,
  list: ALLOW,
  webfetch: ALLOW,
  websearch: ALLOW,
  question: ALLOW,
  edit: { '*': DENY, '.cio/specs/*/versions/**': ALLOW }
}

const leanAgents: readonly LeanOpenCodeAgent[] = [
  {
    name: 'cio-chat',
    description: `Web-only inbox chat inside ${APP_NAME}; answers from the internet, never file operations.`,
    mode: 'primary',
    prompt: [
      `You are a general-purpose web chat assistant inside ${APP_NAME}.`,
      'This chat has no file-system access. Do not traverse, read, search, or modify local files.',
      'When you do not know an answer, search the internet with the web search and web fetch tools instead of inspecting files.',
      'Cite external sources as Markdown links (e.g. `[pr issue #155](https://github.com/org/repo/pull/155)`) — never a bare URL.'
    ].join(' '),
    permission: chatPermission
  },
  {
    name: 'cio-chat-fs',
    description: `File-system-enabled chat inside ${APP_NAME}; read/search/write-free.`,
    mode: 'primary',
    prompt: [
      `You are a general-purpose assistant inside ${APP_NAME} with file-system access enabled.`,
      'The user explicitly granted this chat file operations. Read and search files with the file tools available in this session.',
      'When you do not know an answer, search the internet with the web search and web fetch tools.',
      'Do not modify files unless the user explicitly asks you to.',
      'Cite local findings with project-rooted relative paths (e.g. `src/app.html:42`), never bare filenames or absolute filesystem paths.'
    ].join(' '),
    permission: readResearchPermission
  },
  {
    name: 'cio-eph',
    description: `Read-only temporary ${APP_NAME} chat for inspection questions.`,
    mode: 'primary',
    prompt: [
      `You are answering inside a temporary, read-only ${APP_NAME} chat.`,
      'Answer questions and explain findings using the supplied conversation context.',
      'You may inspect project files and use read-only research tools.',
      'Do not modify files, create specifications or plans, run tests, execute shell commands, or perform any other mutating action.'
    ].join(' '),
    permission: readResearchPermission
  },
  {
    name: 'cio-img-desc',
    description: `Image description worker for ${APP_NAME}'s vision model.`,
    mode: 'primary',
    prompt: [
      `You are ${APP_NAME}'s image descriptor.`,
      'Describe the attached image accurately and concisely: subject, layout, notable text, and details a sighted reviewer would rely on.',
      'Use no tools; describe only what the image shows.'
    ].join(' '),
    permission: imageDescriptionPermission
  },
  {
    name: 'cio-pr-compose',
    description: `Composes GitHub pull-request title and description for ${APP_NAME}.`,
    mode: 'primary',
    prompt: [
      `You compose a pull request title and description for the user's ${APP_NAME} project.`,
      'Use only the repository evidence supplied in the user prompt. Do not inspect the repository or call tools.',
      'Return the result as the JSON object requested by the user prompt.',
      'Never modify files, fetch, commit, push, or touch Engineering lifecycle artifacts.'
    ].join(' '),
    permission: prComposePermission
  },
  {
    name: 'cio-utility-setup',
    description: 'Installs validated utilities through the explicit CodeInOven setup API.',
    mode: 'primary',
    prompt: [
      'Use the turn-scoped CodeInOven utility management API supplied in the system prompt.',
      'Do not write project or harness configuration files directly.'
    ].join(' '),
    permission: utilitySetupPermission
  },
  {
    name: 'cio-brainstorm',
    description: `Evidence-driven brainstorm session reporter for ${APP_NAME}.`,
    mode: 'primary',
    prompt: [
      `You are the Sr. Engineer facilitating a ${APP_NAME} Brainstorm session before specification.`,
      'Research the project with read-only tools and current external facts when they materially affect the direction.',
      'Use the application `question` tool for alignment, never plain-text questions for material choices.',
      `Submit the session report through the ${'brainstorm_document'.toUpperCase()} contract; persist the session-report revision only under .cio/specs/<feature-slug>/versions/.`,
      'Never modify source files, run commands, or implement.'
    ].join(' '),
    permission: brainstormPermission
  }
]

export const LEAN_AGENTS: readonly LeanOpenCodeAgent[] = leanAgents
export const LEAN_AGENT_NAMES: Array<string> = leanAgents.map((agent) => agent.name)

const agentByName = new Map<string, LeanOpenCodeAgent>(
  leanAgents.map((agent) => [agent.name, agent])
)

/** Look up a lean agent definition by its opencode agent name. */
export function leanAgentDefinition(name: string): LeanOpenCodeAgent | undefined {
  return agentByName.get(name)
}

const modeToAgentName: Record<LeanAgentMode, string> = {
  'inbox-chat': 'cio-chat',
  'file-system-chat': 'cio-chat-fs',
  ephemeral: 'cio-eph',
  'image-description': 'cio-img-desc',
  'pr-compose': 'cio-pr-compose',
  'utility-setup': 'cio-utility-setup',
  brainstorm: 'cio-brainstorm'
}

/** Resolve the lean opencode agent name for a trimmed mode. */
export function leanAgentNameForMode(mode: LeanAgentMode): string {
  return modeToAgentName[mode]
}

/** Stable shape used by tests and golden fixtures. */
export interface LeanAgentFixture {
  name: string
  description: string
  mode: 'primary'
  prompt: string
  permission: Record<string, AgentPermissionValue>
}

/** Build the JSON-shaped `agent` map opencode consumes for the lean agents. */
export function leanAgentConfigMap(): Record<string, LeanAgentFixture> {
  return Object.fromEntries(leanAgents.map((agent) => [agent.name, agent]))
}
