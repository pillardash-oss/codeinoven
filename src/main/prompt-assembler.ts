import { readFile } from 'fs/promises'
import { join, resolve } from 'path'
import { APP_NAME } from '../lib/brand'
import type { MemoryService } from './memory-service'

const NESTED_AGENTS_DEPTH_LIMIT = 3

export interface BehaviorLayer {
  title: string
  content: string
  editable: boolean
  defaultOpen: boolean
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
    mode: BehaviorMode = 'implement'
  ): Promise<BehaviorLayer[]> {
    const layers: BehaviorLayer[] = []

    const harnessContent = buildWorkspaceContext(driver, projectPath)
    layers.push({
      title: `Harness: ${driver?.name ?? 'Agent Harness'}`,
      content: harnessContent,
      editable: false,
      defaultOpen: false
    })

    const appContent = this.buildAppLayerContent(mode, systemPromptConstants)
    layers.push({
      title: `Application: CodeInOven (${modeLabel(mode)} mode)`,
      content: appContent,
      editable: false,
      defaultOpen: false
    })

    const memory = await this.memoryService.formatCurrent(projectId, threadId)
    layers.push({
      title: 'Memory',
      content: memory || 'No memory entries configured.',
      editable: false,
      defaultOpen: false
    })

    const projectBehavior = await readAgentsMd(projectPath)
    layers.push({
      title: 'AGENTS.md (Project)',
      content: projectBehavior || 'No project AGENTS.md found.',
      editable: true,
      defaultOpen: true
    })

    const nestedAgents = await scanNestedAgentsMd(projectPath)
    for (const nested of nestedAgents) {
      const dirName = nested.path.split('/').pop() ?? nested.path
      layers.push({
        title: `AGENTS.md (${dirName})`,
        content: nested.content,
        editable: true,
        defaultOpen: true
      })
    }

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
    mode: BehaviorMode = 'implement'
  ): Promise<string> {
    const layers = await this.getLayers(
      projectId,
      threadId,
      projectPath,
      driver,
      systemPromptConstants,
      mode
    )
    const parts = layers
      .map((layer) => {
        const content = layer.content.trim()
        if (!content || (content.startsWith('No ') && content.endsWith(' configured.'))) return ''
        if (content.startsWith('No ') && content.includes(' AGENTS.md found.')) return ''
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
    '2. Unless the user explicitly asks otherwise, put every artifact that is not part of the application source here: context documents the agent or the user should read, plans, progress, walkthroughs, reports, test output, and temporary work.',
    '3. Keep it organized for a human: feature work (plan*.md, progress*.md, walkthroughs, reports, test output) goes in `.cio/uncategorized/<feature>/`; disposable temp work (cloned repos, `.venv`, build scratch) goes in `.cio/tmp/`. Name files so a human can read them at a glance.',
    '4. Never write these outputs to the repository root or the working tree, and never add them to source control.',
    '5. The platform owns `.cio/specs/<feature-slug>/spec.md` and `.cio/git/pr/<n>/`; never create or overwrite files there.'
  ].join('\n')
}

async function readAgentsMd(projectPath: string): Promise<string> {
  try {
    return await readFile(join(projectPath, 'AGENTS.md'), 'utf-8')
  } catch {
    return ''
  }
}

async function scanNestedAgentsMd(
  projectPath: string,
  depth = NESTED_AGENTS_DEPTH_LIMIT
): Promise<Array<{ path: string; content: string }>> {
  const { listDir } = await import('../lib/utils')
  const results: Array<{ path: string; content: string }> = []
  if (depth <= 0) return results
  try {
    const entries = await listDir(projectPath)
    const dirs = entries.filter(
      (entry) => !entry.startsWith('.') && !entry.startsWith('node_modules')
    )
    for (const dir of dirs) {
      const dirPath = join(projectPath, dir)
      try {
        const agentPath = join(dirPath, 'AGENTS.md')
        const content = await readFile(agentPath, 'utf-8')
        if (content.trim()) {
          const relativePath = resolve(projectPath, dir)
          results.push({ path: relativePath, content })
        }
      } catch {
        const nested = await scanNestedAgentsMd(dirPath, depth - 1)
        results.push(...nested)
      }
    }
  } catch {
    // Not a directory or not accessible — skip
  }
  return results
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
