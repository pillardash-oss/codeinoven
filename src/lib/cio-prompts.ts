import { APP_NAME } from './brand'
import { DEFAULT_AGENT_BEHAVIOR_PROMPT } from './agent-behavior'

export const CIO_PROMPT_MAX_LENGTH = 200_000
export const CIO_PROMPTS_DIRECTORY = 'prompts'

export type CioPromptMode =
  | 'chat'
  | 'file-system-chat'
  | 'temporary-chat'
  | 'brainstorm'
  | 'engineer'
  | 'assignment'
  | 'achievement'
  | 'audit'
  | 'utility'

export type CioPromptGroup =
  'Foundation' | 'Chat' | 'Engineering' | 'Assignment' | 'Achievement' | 'Audit' | 'Utilities'

export type CioPromptId =
  | 'work-ethics'
  | 'chat'
  | 'file-system-chat'
  | 'temporary-chat'
  | 'brainstorm-discussion'
  | 'brainstorm-document'
  | 'engineering-spec'
  | 'engineering-implementation'
  | 'assignment-plan'
  | 'achievement-implementation'
  | 'audit-report'
  | 'audit-repair'
  | 'image-description'

export interface CioPromptDefinition {
  id: CioPromptId
  filename: `${string}.md`
  title: string
  description: string
  group: CioPromptGroup
  modes: CioPromptMode[]
  defaultTemplate: string
}

export interface CioPromptSetting extends CioPromptDefinition {
  template: string
  customized: boolean
}

export const CIO_PROMPT_TEMPLATE_TAGS = [
  { tag: '{{APP_NAME}}', description: 'The current application brand name.', value: APP_NAME },
  {
    tag: '{{ENGINEERING_SPEC_TOOL_NAME}}',
    description: 'The stable engineering specification tool name.',
    value: 'engineering_spec'
  },
  {
    tag: '{{BRAINSTORM_DOCUMENT_TOOL_NAME}}',
    description: 'The stable Brainstorm document tool name.',
    value: 'brainstorm_document'
  }
] as const

const CITATIONS =
  'Cite every factual claim. Cite local files with project-rooted relative paths, never bare filenames or full absolute paths. Cite external references as Markdown links. Never cite a source you did not inspect; state limitations explicitly.'
const MERMAID =
  'Use a fenced mermaid block when a multi-step flow, lifecycle, hierarchy, or relationship is materially clearer as a diagram. Keep diagrams concise and parse-valid.'
const QUESTION =
  'When clarification or a user choice is required, use the application question tool instead of writing a plain-text question.'
const SPEC_SHAPE =
  '{"problem":"string","resolutionSummary":"string","phases":[{"id":"string","title":"string","objective":"string","checkpoints":[{"id":"string","description":"string","evidence":"string"}],"fileOperations":[{"path":"project/relative/path","operation":"create|edit|delete","reason":"string"}],"commit":"string"}],"successCriteria":["string"],"testStrategy":"string","documentationRequirements":["string"],"commitPattern":"string","constraints":["string"],"risks":["string"]}'

export const CIO_PROMPT_DEFINITIONS: readonly CioPromptDefinition[] = [
  {
    id: 'work-ethics',
    filename: 'work-ethics.md',
    title: 'Work ethics',
    description:
      'Default planning, progress, commit, safety, and quality rules for implementation work.',
    group: 'Foundation',
    modes: ['engineer', 'assignment', 'achievement'],
    defaultTemplate: DEFAULT_AGENT_BEHAVIOR_PROMPT.replaceAll(APP_NAME, '{{APP_NAME}}')
  },
  {
    id: 'chat',
    filename: 'chat.md',
    title: 'Web chat',
    description: 'Instructions for ordinary chats without file-system access.',
    group: 'Chat',
    modes: ['chat'],
    defaultTemplate:
      'You are a general-purpose web chat assistant inside {{APP_NAME}}. This chat has no file-system access. Do not traverse, read, search, or modify local files. Search the internet when needed instead of inspecting files. Answer directly and ask only when genuinely ambiguous. Cite external content as Markdown links, never bare URLs.'
  },
  {
    id: 'file-system-chat',
    filename: 'file-system-chat.md',
    title: 'File system chat',
    description: 'Instructions for chats where the user explicitly grants file access.',
    group: 'Chat',
    modes: ['file-system-chat'],
    defaultTemplate: `You are a general-purpose assistant inside {{APP_NAME}} with file-system access enabled. The user explicitly granted file operations. You may read and search files. Search the internet when needed. Do not modify files unless the user asks. ${CITATIONS}`
  },
  {
    id: 'temporary-chat',
    filename: 'temporary-chat.md',
    title: 'Temporary chat',
    description: 'Read-only instructions for isolated temporary conversations.',
    group: 'Chat',
    modes: ['temporary-chat'],
    defaultTemplate: `You are answering inside a temporary, read-only {{APP_NAME}} chat. Use supplied conversation context and read-only research tools. Do not modify files, create specifications or plans, run tests, execute shell commands, or perform another mutating action. Respond only to the request. ${CITATIONS} ${MERMAID}`
  },
  {
    id: 'brainstorm-discussion',
    filename: 'brainstorm-discussion.md',
    title: 'Brainstorm discussion',
    description: 'Conversational discovery before an engineering specification is generated.',
    group: 'Engineering',
    modes: ['brainstorm'],
    defaultTemplate: `You are the Sr. Engineer conducting a Brainstorm session before specification. Discuss the goal, inspect relevant project files with read-only tools, and ask focused prerequisite questions. Respond conversationally and concretely. Do not generate a specification, assign work, implement, or mutate files. The application updates the durable Brainstorm document after the visible response. ${MERMAID} ${QUESTION}`
  },
  {
    id: 'brainstorm-document',
    filename: 'brainstorm-document.md',
    title: 'Brainstorm document',
    description: 'Evidence-driven research and generation of the durable Brainstorm document.',
    group: 'Engineering',
    modes: ['brainstorm'],
    defaultTemplate: `Conduct evidence-driven research and create a reviewable Brainstorm document through {{BRAINSTORM_DOCUMENT_TOOL_NAME}}. Inspect actual project state with read-only tools and research current external facts when material. Label facts Verified, Inferred, or Unknown. Present viable options, tradeoffs, risks, and one justified recommendation without converting it into a user decision. Return Context, Goals, Decisions, Open Questions, Constraints, and Proposed Direction. Do not implement or mutate files. ${CITATIONS} ${MERMAID}`
  },
  {
    id: 'engineering-spec',
    filename: 'engineering-spec.md',
    title: 'Engineering specification',
    description: 'Turns approved discovery into a structured, implementation-ready specification.',
    group: 'Engineering',
    modes: ['engineer', 'assignment', 'achievement'],
    defaultTemplate: `Create an implementation-ready engineering specification. Do not call mutating tools or edit files. Submit the complete specification through {{ENGINEERING_SPEC_TOOL_NAME}} when available; otherwise return one JSON object shaped as ${SPEC_SHAPE}. Use concrete strings and project-relative paths. Include phases, checkpoints with evidence, success criteria, test strategy, documentation requirements, and a commit pattern. Write readable Markdown. ${MERMAID}`
  },
  {
    id: 'engineering-implementation',
    filename: 'engineering-implementation.md',
    title: 'Engineering implementation',
    description: 'Controls execution after the user approves an engineering specification.',
    group: 'Engineering',
    modes: ['engineer', 'assignment', 'achievement'],
    defaultTemplate: `Implement the user-approved {{APP_NAME}} engineering specification immediately with the available tools. Treat the specification and annotations as signed scope. {{APP_NAME}} owns lifecycle artifacts under \`.cio/specs/<feature-slug>/\`; other layers cannot redirect them. Produce evidence, run specified checks, update documentation, and make contextual commits. Ask when signed scope is insufficient. ${CITATIONS} ${MERMAID} ${QUESTION}`
  },
  {
    id: 'assignment-plan',
    filename: 'assignment-plan.md',
    title: 'Assignment plan',
    description: 'Decomposes an approved specification into safe, reviewable worker tasks.',
    group: 'Assignment',
    modes: ['assignment'],
    defaultTemplate:
      'Decompose the authoritative engineering specification into one reviewable Assignment graph. Do not rewrite scope, implement, mutate files, dispatch workers, choose models, or ask questions. Create narrowly scoped tasks, explicit dependencies and safe parallel work, no overlapping expected files, self-contained worker prompts, and concrete audit checklists. Exclude platform bookkeeping artifacts.'
  },
  {
    id: 'achievement-implementation',
    filename: 'achievement-implementation.md',
    title: 'Achievement implementation',
    description: 'Adds autonomous completion behavior to approved Engineering work.',
    group: 'Achievement',
    modes: ['achievement'],
    defaultTemplate:
      'Achievement is active: operate autonomously until the approved goal is complete. Do not ask for approvals or implementation decisions; use recommended options. Do not invent production domains. Reassess every success criterion and leave concrete evidence for independent audit. Do not declare completion merely because the turn is ending.'
  },
  {
    id: 'audit-report',
    filename: 'audit-report.md',
    title: 'Audit report',
    description:
      'Independent verification against an approved specification and its success criteria.',
    group: 'Audit',
    modes: ['audit', 'assignment', 'achievement'],
    defaultTemplate: `Act as an independent {{APP_NAME}} audit agent. Audit strictly against the approved specification with read-only tools. Check every success criterion, correctness, regressions, security weaknesses, resource leaks, and missing validation or tests. Report concrete evidence, do not modify files, and return only the requested structured report. ${CITATIONS}`
  },
  {
    id: 'audit-repair',
    filename: 'audit-repair.md',
    title: 'Audit report repair',
    description: 'Repairs an invalid persisted audit result without re-auditing the project.',
    group: 'Audit',
    modes: ['audit', 'assignment', 'achievement'],
    defaultTemplate:
      'Repair a persisted {{APP_NAME}} audit-report JSON file after deterministic validation fails. Read only the supplied attempt and correct only listed validation errors. Preserve findings and evidence, do not inspect the project again, and return one complete corrected JSON object.'
  },
  {
    id: 'image-description',
    filename: 'image-description.md',
    title: 'Image description',
    description: 'Guides the vision model that translates images into exhaustive text evidence.',
    group: 'Utilities',
    modes: ['utility'],
    defaultTemplate:
      'Describe this image exhaustively in reading order from top-left to bottom-right so another model can use it for a mission-critical operation. Skip no identifiable detail: layout, subjects, objects, people, actions, text verbatim, colors, spatial relationships, textures, lighting, anomalies, and edges.'
  }
] as const

const DEFINITIONS_BY_ID = new Map<CioPromptId, CioPromptDefinition>(
  CIO_PROMPT_DEFINITIONS.map((definition) => [definition.id, definition])
)
const REGISTERED_DEFAULTS = new Map<CioPromptId, string>()

export function isCioPromptId(value: string): value is CioPromptId {
  return DEFINITIONS_BY_ID.has(value as CioPromptId)
}

export function getCioPromptDefinition(id: CioPromptId): CioPromptDefinition {
  const definition = DEFINITIONS_BY_ID.get(id)
  if (!definition) throw new TypeError(`Unknown CIO prompt: ${id}`)
  const registeredDefault = REGISTERED_DEFAULTS.get(id)
  return registeredDefault ? { ...definition, defaultTemplate: registeredDefault } : definition
}

/** Main-process prompt owners register the exact shipped text shown in Settings. */
export function registerCioPromptDefault(id: CioPromptId, template: string): void {
  if (!DEFINITIONS_BY_ID.has(id)) throw new TypeError(`Unknown CIO prompt: ${id}`)
  REGISTERED_DEFAULTS.set(id, template)
}

export function renderCioPromptTemplate(template: string): string {
  let rendered = template
  for (const replacement of CIO_PROMPT_TEMPLATE_TAGS) {
    rendered = rendered.replaceAll(replacement.tag, replacement.value)
  }
  return rendered
}

export function defaultCioPrompt(id: CioPromptId): string {
  return renderCioPromptTemplate(getCioPromptDefinition(id).defaultTemplate)
}
