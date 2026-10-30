import { canonicalGitHubBranch, isRecord } from '../shared'
import { validateBoundedString, validateBranchName } from '../../ipc-validation'
import type { AgentMessage, PrComposeInput } from '../../../../lib/types'
import type { PullRequestComposeContext } from '../../../git/git-service'

export const PR_COMPOSE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' }
  }
} as const

export const PR_COMPOSE_SYSTEM_PROMPT = [
  'You write pull request titles and descriptions from repository evidence supplied in the user message.',
  'Use only that evidence. Do not inspect the repository, call tools, ask questions, or perform Git operations.',
  'Return one JSON object with exactly the requested title and description fields.'
].join(' ')

export function validatePrComposeInput(value: unknown): PrComposeInput {
  if (!isRecord(value)) throw new TypeError('PR compose input must be an object')
  const source = value['source']
  if (source !== 'remote' && source !== 'local') {
    throw new TypeError('PR compose source must be remote or local')
  }
  if (typeof value['includeWorkingTree'] !== 'boolean') {
    throw new TypeError('PR compose working tree choice must be a boolean')
  }
  const currentTitle = value['currentTitle']
  const currentDescription = value['currentDescription']
  return {
    base: canonicalGitHubBranch(validateBranchName(value['base'], 'PR compose base')),
    head: canonicalGitHubBranch(validateBranchName(value['head'], 'PR compose head')),
    source,
    includeWorkingTree: value['includeWorkingTree'],
    ...(currentTitle === undefined
      ? {}
      : { currentTitle: validateBoundedString(currentTitle, 'Current PR title', 0, 512) }),
    ...(currentDescription === undefined
      ? {}
      : {
          currentDescription: validateBoundedString(
            currentDescription,
            'Current PR description',
            0,
            100_000
          )
        })
  }
}

export function prComposePrompt(input: PrComposeInput, context: PullRequestComposeContext): string {
  const sections = [
    `Write a pull request for merging ${JSON.stringify(input.head)} into ${JSON.stringify(input.base)}.`,
    '',
    context.source === 'remote'
      ? 'The selected branches are cached origin refs. The app performed read-only comparisons and did not fetch or change the repository.'
      : 'The selected head is local. Cover the complete pull request range and the pending push, including the current worktree evidence below.',
    '',
    `Complete PR commit range (${context.baseRef}..${context.headRef}):`,
    context.commits || '(no commit subjects available)',
    '',
    'Complete PR file summary:',
    context.diffSummary || '(no file summary available)',
    '',
    'Complete PR patch evidence:',
    context.patch || '(no patch available)'
  ]
  if (context.source === 'local') {
    sections.push(
      '',
      context.pendingPushBaseRef
        ? `Commits since the last cached push (${context.pendingPushBaseRef}..${context.headRef}):`
        : 'The head has no cached origin branch. Treat the complete PR range as the pending first push.',
      context.pendingCommits || '(no additional committed changes)',
      '',
      'Pending push file summary:',
      context.pendingDiffSummary || '(no additional committed file changes)',
      '',
      'Pending push patch evidence:',
      context.pendingPatch || '(no additional committed patch)',
      '',
      'Tracked worktree changes that will be committed before pushing:',
      context.worktreePatch || '(none)',
      '',
      'Untracked files that will be committed before pushing:',
      context.untrackedFiles || '(none)'
    )
  }
  if (input.currentTitle !== undefined || input.currentDescription !== undefined) {
    sections.push(
      '',
      'Improve the existing draft while keeping it faithful to the evidence:',
      `Current title: ${JSON.stringify(input.currentTitle ?? '')}`,
      'Current description:',
      input.currentDescription?.trim() || '(empty)'
    )
  }
  if (context.truncated) {
    sections.push(
      '',
      'Some large evidence was truncated. Do not claim details absent from the text.'
    )
  }
  sections.push(
    '',
    'Write a concise one-line title in imperative mood. The description must summarize what changed, why it changed when the evidence shows that, and what reviewers should know.',
    'Return only JSON with this exact shape:',
    '{"title":"The pull request title","description":"The pull request description"}'
  )
  return sections.join('\n')
}

function prComposePayload(value: unknown): { title: string; description: string } | null {
  if (!isRecord(value) || typeof value['title'] !== 'string') return null
  return {
    title: value['title'],
    description: typeof value['description'] === 'string' ? value['description'] : ''
  }
}

function prComposeResponseText(response: AgentMessage): string {
  return response.parts
    .flatMap((part) => (part.type === 'text' && part.phase !== 'commentary' ? [part.text] : []))
    .join('\n')
    .trim()
}

/** Read the compose result from a harness response without requiring the agent
 *  to write into the project. JSON-only prompts should parse directly, while
 *  fences and a short explanatory wrapper are tolerated across CLI providers. */
export function prComposeResponse(response: AgentMessage): { title: string; description: string } {
  const structured = prComposePayload(response.structuredOutput)
  if (structured) return structured

  const text = prComposeResponseText(response)
  const candidates = [text]
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    if (match[1]) candidates.push(match[1].trim())
  }
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) {
    candidates.push(text.slice(objectStart, objectEnd + 1))
  }

  for (const candidate of candidates) {
    try {
      const payload = prComposePayload(JSON.parse(candidate) as unknown)
      if (payload) return payload
    } catch {
      // Try the next provider-compatible response shape.
    }
  }
  throw new Error('The PR compose agent returned invalid JSON')
}

export function hasPrComposeResponse(response: AgentMessage): boolean {
  try {
    prComposeResponse(response)
    return true
  } catch {
    return false
  }
}

export function prComposeRepairPrompt(response: AgentMessage, attempt: number): string {
  const draft = prComposeResponseText(response).slice(0, 100_000)
  return [
    `Correction attempt ${attempt}. Your previous answer was not valid JSON.`,
    'Convert it into exactly one JSON object with string fields named title and description.',
    'Keep the same factual content. Escape every line break inside a JSON string as \\n.',
    'Do not use a Markdown fence or add explanatory text.',
    'Return only this shape:',
    '{"title":"The pull request title","description":"The pull request description"}',
    '',
    'Previous answer:',
    draft || '(empty)'
  ].join('\n')
}
