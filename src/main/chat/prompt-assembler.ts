import { createHash } from 'node:crypto'
import { APP_NAME } from '../../lib/brand'
import {
  AGENT_BEHAVIOR_PROMPT_MAX_LENGTH,
  DEFAULT_AGENT_BEHAVIOR_PROMPT
} from '../../lib/agent-behavior'
import type { MemoryService } from './memory-service'

export interface BehaviorLayer {
  title: string
  content: string
  editable: boolean
  defaultOpen: boolean
  /** True for display-only layers that must not be sent to the harness. */
  skipInPrompt?: boolean
  /** Normalized development hash of the layer content. */
  devHash?: string
  /** Raw character count of the layer content. */
  characters?: number
  /** Heuristic token estimate (~4 characters per token). */
  estimatedTokens?: number
}

/** Attach normalized-hash and character/token accounting to a behavior layer
 *  without exposing or logging the layer content. */
function withLayerAccounting(layer: BehaviorLayer): BehaviorLayer {
  const report = layerSize(layer.content)
  return {
    ...layer,
    devHash: layerDevHash(layer.content),
    characters: report.characters,
    estimatedTokens: report.estimatedTokens
  }
}

/** Minimal driver info needed for the behavior layer display. */
export interface DriverInfo {
  id: string
  name: string
}

/**
 * Mode for the Application prompt layer. Mirrors the runtime decision in
 * `ChatEngine.sendPrompt`:
 *
 * - `'brainstorm'` — the planning/spec branch sends `SPEC_BRAINSTORM_SYSTEM_PROMPT`
 *   (which already embeds the mermaid instruction).
 * - `'implement'` — the implement branch sends `SPEC_IMPLEMENT_SYSTEM_PROMPT` and
 *   excludes `MERMAID_OUTPUT_INSTRUCTION`.
 * - `'chat'` — engineering prompts are omitted while shared behavior and memory remain active.
 */
export type BehaviorMode = 'brainstorm' | 'implement' | 'chat'

/**
 * Collapse every whitespace run into a single space so structurally identical
 * instruction layers hash equally regardless of line wrapping or indentation.
 * Used only to derive normalized development hashes — the content itself is
 * never logged or emitted.
 */
export function normalizeLayerContent(content: string): string {
  return content.replace(/\s+/gu, ' ').trim()
}

/** Stable development hash of a layer's normalized content. */
export function layerDevHash(content: string): string {
  return createHash('sha256').update(normalizeLayerContent(content), 'utf8').digest('hex')
}

export interface LayerSizeReport {
  /** Raw character count of the layer content. */
  characters: number
  /** Heuristic token estimate (~4 characters per token) for development
   *  accounting. Does not include content. */
  estimatedTokens: number
}

/** Per-layer character/token accounting without exposing the layer content. */
export function layerSize(content: string): LayerSizeReport {
  const characters = content.length
  return { characters, estimatedTokens: Math.ceil(characters / 4) }
}

export class PromptAssembler {
  constructor(private readonly memoryService: MemoryService) {}

  async getLayers(
    projectId: string,
    threadId: string,
    projectPath: string,
    driver: DriverInfo | null,
    systemPromptConstants?: {
      SPEC_BRAINSTORM_SYSTEM_PROMPT?: string
      SPEC_IMPLEMENT_SYSTEM_PROMPT?: string
      MERMAID_OUTPUT_INSTRUCTION?: string
    },
    mode: BehaviorMode = 'implement',
    agentBehaviorPrompt = DEFAULT_AGENT_BEHAVIOR_PROMPT
  ): Promise<BehaviorLayer[]> {
    const layers: BehaviorLayer[] = []

    const harnessContent = buildWorkspaceContext(driver, projectPath)
    layers.push(
      withLayerAccounting({
        title: `Harness: ${driver?.name ?? 'Agent Harness'}`,
        content: harnessContent,
        editable: false,
        defaultOpen: false
      })
    )

    if (mode === 'implement') {
      layers.push(
        withLayerAccounting({
          title: 'Agent behavior (Engineering implementation)',
          content: normalizeAgentBehaviorPrompt(agentBehaviorPrompt),
          editable: true,
          defaultOpen: false
        })
      )
    }

    const appContent = this.buildAppLayerContent(mode, systemPromptConstants)
    layers.push(
      withLayerAccounting({
        title: `Application: CodeInOven (${modeLabel(mode)} mode)`,
        content: appContent,
        editable: false,
        defaultOpen: false
      })
    )

    const memory = await this.memoryService.formatCurrent(projectId, threadId)
    layers.push(
      withLayerAccounting({
        title: 'Memory',
        content: memory || 'No memory entries configured.',
        editable: false,
        defaultOpen: false
      })
    )

    return layers
  }

  /**
   * Build the Application layer content for a given mode. The runtime
   * (`ChatEngine.sendPrompt`) sends only ONE of these constants per turn, never
   * both. Showing both would mislead the user about what is actually sent.
   * Memory is a separate canonical layer and is never folded into the app layer.
   */
  private buildAppLayerContent(
    mode: BehaviorMode,
    constants?: {
      SPEC_BRAINSTORM_SYSTEM_PROMPT?: string
      SPEC_IMPLEMENT_SYSTEM_PROMPT?: string
      MERMAID_OUTPUT_INSTRUCTION?: string
    }
  ): string {
    const parts: string[] = []
    if (mode === 'implement' && constants?.SPEC_IMPLEMENT_SYSTEM_PROMPT) {
      parts.push(constants.SPEC_IMPLEMENT_SYSTEM_PROMPT)
    } else if (mode === 'brainstorm' && constants?.SPEC_BRAINSTORM_SYSTEM_PROMPT) {
      parts.push(constants.SPEC_BRAINSTORM_SYSTEM_PROMPT)
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No application prompts configured.'
  }

  async getAssembledPrompt(
    projectId: string,
    threadId: string,
    projectPath: string,
    driver: DriverInfo | null,
    extraContent = '',
    systemPromptConstants?: {
      SPEC_BRAINSTORM_SYSTEM_PROMPT?: string
      SPEC_IMPLEMENT_SYSTEM_PROMPT?: string
      MERMAID_OUTPUT_INSTRUCTION?: string
    },
    mode: BehaviorMode = 'implement',
    agentBehaviorPrompt = DEFAULT_AGENT_BEHAVIOR_PROMPT
  ): Promise<string> {
    const layers = await this.getLayers(
      projectId,
      threadId,
      projectPath,
      driver,
      systemPromptConstants,
      mode,
      agentBehaviorPrompt
    )
    const parts = layers
      .filter((layer) => layer.skipInPrompt !== true)
      .map((layer) => {
        const content = layer.content.trim()
        if (!content || (content.startsWith('No ') && content.endsWith(' configured.'))) return ''
        return content
      })
      .filter(Boolean)
    if (extraContent.trim()) parts.push(extraContent)
    return parts.join('\n\n')
  }
}

/**
 * Build the workspace-scope context shown to the model. This is the hard
 * guarantee that keeps the agent on the project the user actually opened in
 * the app instead of drifting into the underlying harness's own codebase.
 */
function buildWorkspaceContext(driver: DriverInfo | null, projectPath: string): string {
  const harnessLine = driver
    ? `The active agent harness underneath is ${driver.name} (${driver.id}); it is only the execution engine that runs the session and tooling — it is NOT the project you are working on and NOT the user's target.`
    : 'No agent harness is currently selected, so this session may be limited.'
  const projectLine = projectPath.trim()
    ? `Your project is the project the user has open in ${APP_NAME}, at: ${projectPath}.`
    : `Your project is the project the user has open in ${APP_NAME}.`
  const harnessRepo = driver
    ? `the ${driver.id} CLI repository or its global config directories`
    : 'the agent harness CLI repository or its global config directories'
  const citationRoot = projectPath.trim() ? projectPath : '<project-cwd>'
  return [
    `You are working inside ${APP_NAME}, a desktop control plane (UI wrapper) that coordinates agentic software engineering on a user's project. The user interacts with you through the ${APP_NAME} UI and has a specific project open in it.`,
    harnessLine,
    '',
    'WORKING SCOPE — this overrides ambiguous instructions:',
    `1. ${projectLine} All work targets that project and only that project.`,
    `2. Unless the user explicitly names the agent harness or ${APP_NAME} itself, every request refers to the current open project. Do not reinterpret "this project", "the app", "the repository", or similar references as the harness's own codebase, the ${APP_NAME} codebase, or any other repository.`,
    `3. Only read, assess, or modify files inside the current project. Never inspect or edit the agent harness's own source code, configuration, caches, or documentation (for example ${harnessRepo}), and never touch ${APP_NAME}'s own repository or configuration directory unless that repository is the current open project or the user explicitly asks you to.`,
    "4. Instructions provided by the harness describe how to use the harness's tooling and file operations; they never redefine which project you are working on or widen the file scope beyond the current project.",
    '5. When a request is ambiguous about scope, ask the user which project or files they mean instead of guessing or working on unrelated files.',
    '',
    'AGENT SCRATCH SPACE — where non-source outputs live:',
    `1. The project's \`.cio/\` folder is the agent scratch pad. ${APP_NAME} creates it when the project is added and gitignores it from day one, so nothing inside it is ever committed.`,
    '2. Unless the user explicitly asks otherwise, put every artifact that is not part of the application source here: context documents, walkthroughs, reports, test output, and temporary work.',
    '3. CodeInOven-managed Engineering lifecycle files (spec.md, plan.md, progress.md, Assignment, audit, and task evidence) belong in `.cio/specs/<feature-slug>/`; other feature work (walkthroughs, reports, and test output) belongs in `.cio/work/<feature>/`; disposable temp work belongs in `.cio/tmp/`. Name files so a human can read them at a glance.',
    '4. Never write these outputs to the repository root or the working tree, and never add them to source control.',
    '5. The platform owns `.cio/specs/<feature-slug>/spec.md` and `.cio/git/pr/<n>/`; never create or overwrite files there.',
    '',
    'CITATION & SOURCE RULES — apply to every report, answer, and artifact you produce:',
    `1. Cite the source of every factual claim. Files must be cited with their full project-rooted path, e.g. \`${citationRoot}/src/app.html\` — never a bare filename like \`app.html\`, because a bare filename is not traceable.`,
    '2. External references must be Markdown links, e.g. `[pr issue #155](https://github.com/org/repo/pull/155)` — never bare text such as "pr issue #155".',
    '3. Never cite a source you did not inspect or retrieve; when a claim cannot be verified, state that limitation instead of padding the report with references.'
  ].join('\n')
}

function normalizeAgentBehaviorPrompt(prompt: string): string {
  const normalized = prompt.trim()
  if (normalized.length === 0) return DEFAULT_AGENT_BEHAVIOR_PROMPT
  return normalized.slice(0, AGENT_BEHAVIOR_PROMPT_MAX_LENGTH)
}

function modeLabel(mode: BehaviorMode): string {
  switch (mode) {
    case 'implement':
      return 'Implement'
    case 'chat':
      return 'Chat'
    case 'brainstorm':
      return 'Brainstorm'
  }
}
