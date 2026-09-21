import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { APP_NAME } from '../../../lib/brand'
import { harnessGlobalSkillPath, SHARED_GLOBAL_SKILL_PATH } from '../../../lib/native-skill-paths'
import { isDevelopmentEnvironment, validateBaseUrl } from '../../providers/base-url'
import { resolveDeploymentProvider } from '../../providers/registry'
import { UtilityRegistryService } from '../../utilities/utility-registry-service'
import { listInstalledSkillLocations } from '../../utilities/installed-skill-locations'
import { runSkillsCli } from '../../utilities/skills-cli'
import { uninstallMarketSkill } from '../../utilities/skill-uninstall'
import { listHarnesses } from '../../agents/harness-registry'
import { Logger } from '../../system/logger'
import { CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES } from '../../../lib/types'
import {
  validateBoundedString,
  validateBranchName,
  validateEntityId,
  validatePrCommentBody,
  validatePrCommentId,
  validatePrCommentKind,
  validatePrMinimizeReason,
  validateGraphqlNodeId,
  validatePrNumber,
  validatePrReviewEvent,
  validateThreadSettings
} from '../ipc-validation'
import { isRecord, requireString, runGitHubMutation, validateStringArray } from './shared'
import { canonicalGitHubBranch } from './shared'
import { requireTimestamp } from './spec-helpers'
import { trustedIpcMain as ipcMain } from '../trusted-ipc-main'
import type {
  AgentMessage,
  CloudDeploymentConfig,
  CloudDeploymentContainer,
  CloudDeploymentProjectProviderAccounts,
  CloudDeploymentProviderAccount,
  CloudDeploymentProviderKind,
  CloudDeploymentStatus,
  PrComposeInput,
  SkillMarketDetail,
  UtilityDefinitionInput
} from '../../../lib/types'
import type { PullRequestComposeContext } from '../../git/git-service'
import type { DeploymentProviderContext } from '../../providers/deployment-provider.interface'
import type { IpcHandlerContext } from './context'

const CLOUD_DEPLOYMENT_PROVIDER_KINDS = new Set<string>(CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES)
const CLOUD_DEPLOYMENT_STATUSES = new Set<string>(['building', 'success', 'failed', 'unknown'])
const CLOUD_DEPLOYMENT_MAX_TOKEN_LENGTH = 16_384

function validateCloudDeploymentProviderKind(
  value: unknown,
  label = 'Provider kind'
): CloudDeploymentProviderKind {
  if (typeof value !== 'string' || !CLOUD_DEPLOYMENT_PROVIDER_KINDS.has(value)) {
    throw new TypeError(
      `${label} must be one of: ${CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES.join(', ')}`
    )
  }
  return value as CloudDeploymentProviderKind
}

function validateCloudDeploymentStatus(value: unknown, label: string): CloudDeploymentStatus {
  if (typeof value !== 'string' || !CLOUD_DEPLOYMENT_STATUSES.has(value)) {
    throw new TypeError(`${label} status must be building, success, failed, or unknown`)
  }
  return value as CloudDeploymentStatus
}

function validateCloudDeploymentContainer(value: unknown, index: number): CloudDeploymentContainer {
  if (!isRecord(value)) throw new TypeError(`Cloud deployment container ${index} must be an object`)
  return {
    id: requireString(value.id, `Cloud deployment container ${index} ID`, true),
    label: requireString(value.label, `Cloud deployment container ${index} label`),
    providerKind: validateCloudDeploymentProviderKind(
      value.providerKind,
      `Cloud deployment container ${index} provider kind`
    ),
    status: validateCloudDeploymentStatus(value.status, `Cloud deployment container ${index}`),
    ...(typeof value.accountId === 'string'
      ? {
          accountId: requireString(
            value.accountId,
            `Cloud deployment container ${index} account ID`,
            true
          )
        }
      : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(value.createdAt === undefined
      ? {}
      : {
          createdAt: requireTimestamp(
            value.createdAt,
            `Cloud deployment container ${index} creation`
          )
        }),
    ...(value.updatedAt === undefined
      ? {}
      : {
          updatedAt: requireTimestamp(value.updatedAt, `Cloud deployment container ${index} update`)
        }),
    ...(typeof value.log === 'string' ? { log: value.log } : {})
  }
}

/**
 * Validate a project's per-provider account association. The active account id,
 * when set, must reference one of the attached account ids.
 */
function validateCloudDeploymentProjectProviderAccounts(
  value: unknown,
  kind: CloudDeploymentProviderKind
): CloudDeploymentProjectProviderAccounts {
  if (!isRecord(value)) {
    throw new TypeError(`Cloud deployment account association for ${kind} must be an object`)
  }
  if (!Array.isArray(value.attachedAccountIds)) {
    throw new TypeError(`Cloud deployment account association for ${kind} must have attached ids`)
  }
  const attachedAccountIds = value.attachedAccountIds.map((id, index) =>
    requireString(id, `${kind} attached account ID ${index}`, true)
  )
  const activeAccountId =
    value.activeAccountId === null
      ? null
      : requireString(value.activeAccountId, `${kind} active account ID`, true)
  if (activeAccountId !== null && !attachedAccountIds.includes(activeAccountId)) {
    throw new TypeError(`Active account ${activeAccountId} is not attached for ${kind}`)
  }
  return { attachedAccountIds, activeAccountId }
}

/**
 * Validate a renderer-supplied cloud deployment config at the IPC boundary.
 * `projectId` is pinned to the channel argument so the renderer cannot persist
 * a config for a different project by passing a mismatched body. Accounts
 * themselves live in the global registry; this only validates the project's
 * provider/container selection and account association.
 */
function validateCloudDeploymentConfig(value: unknown, projectId: string): CloudDeploymentConfig {
  if (!isRecord(value)) throw new TypeError('Cloud deployment config must be an object')
  if (value.version !== 3) throw new TypeError('Unsupported cloud deployment config schema')
  if (validateEntityId(value.projectId, 'Config project ID') !== projectId) {
    throw new TypeError('Config project ID does not match the requested project')
  }
  if (!isRecord(value.project)) {
    throw new TypeError('Cloud deployment project config must be an object')
  }
  if (!Array.isArray(value.project.providers)) {
    throw new TypeError('Cloud deployment providers must be an array')
  }
  if (!Array.isArray(value.project.containers)) {
    throw new TypeError('Cloud deployment containers must be an array')
  }

  const providers: CloudDeploymentProviderKind[] = value.project.providers.map((provider, index) =>
    validateCloudDeploymentProviderKind(provider, `Provider ${index}`)
  )
  const seen = new Set<CloudDeploymentProviderKind>()
  for (const provider of providers) {
    if (seen.has(provider)) throw new TypeError(`Duplicate cloud deployment provider: ${provider}`)
    seen.add(provider)
  }

  const containers = value.project.containers.map((container, index) =>
    validateCloudDeploymentContainer(container, index)
  )
  const containerKeys = new Set<string>()
  for (const container of containers) {
    if (!providers.includes(container.providerKind)) {
      throw new TypeError(
        `Container ${container.id} references provider ${container.providerKind} that is not selected`
      )
    }
    const key = `${container.providerKind}/${container.id}`
    if (containerKeys.has(key)) {
      throw new TypeError(`Duplicate cloud deployment container mapping: ${key}`)
    }
    containerKeys.add(key)
  }

  let providerAccounts: CloudDeploymentConfig['project']['providerAccounts']
  if (value.project.providerAccounts === undefined) {
    providerAccounts = undefined
  } else if (!isRecord(value.project.providerAccounts)) {
    throw new TypeError('Cloud deployment account association must be an object')
  } else {
    providerAccounts = {}
    for (const key of Object.keys(value.project.providerAccounts)) {
      const kind = validateCloudDeploymentProviderKind(key)
      providerAccounts[kind] = validateCloudDeploymentProjectProviderAccounts(
        value.project.providerAccounts[key],
        kind
      )
    }
  }

  return {
    version: 3,
    projectId,
    project: {
      providers,
      containers,
      ...(providerAccounts === undefined ? {} : { providerAccounts })
    },
    updatedAt: requireTimestamp(value.updatedAt, 'Cloud deployment config update')
  }
}

function validateProviderToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > CLOUD_DEPLOYMENT_MAX_TOKEN_LENGTH ||
    value.includes('\0')
  ) {
    throw new TypeError(
      `Provider token must be a string of at most ${CLOUD_DEPLOYMENT_MAX_TOKEN_LENGTH} characters`
    )
  }
  return value
}

function validateAccountLabel(value: unknown): string {
  return requireString(value, 'Account label')
}

function validateProviderBaseUrl(value: unknown, kind: CloudDeploymentProviderKind): string {
  if (typeof value !== 'string') throw new TypeError(`${kind} base URL must be a string`)
  const result = validateBaseUrl(value, { development: isDevelopmentEnvironment() })
  if (!result.ok || result.baseUrl === null) {
    throw new TypeError(`Invalid ${kind} base URL: ${result.reason ?? 'unsupported value'}`)
  }
  return result.baseUrl
}

/**
 * Fold a provider's live container results into the project's configured
 * container mappings for one provider kind. Only containers the user has mapped
 * are returned; each keeps the configured id and the user's custom label
 * (overriding whatever the provider reports). A mapped container the provider
 * has not returned yet is still represented with an unknown/available status so
 * configured containers always appear in the panel.
 */
function mergeCloudDeploymentContainers(
  providerContainers: CloudDeploymentContainer[],
  mappedContainers: CloudDeploymentContainer[],
  kind: CloudDeploymentProviderKind
): CloudDeploymentContainer[] {
  const byId = new Map<string, CloudDeploymentContainer>()
  for (const container of providerContainers) byId.set(container.id, container)

  const merged: CloudDeploymentContainer[] = []
  for (const mapping of mappedContainers) {
    if (mapping.providerKind !== kind) continue
    const live = byId.get(mapping.id)
    if (!live) {
      merged.push({ ...mapping, status: 'unknown' })
      continue
    }
    merged.push({
      id: mapping.id,
      label: mapping.label,
      providerKind: kind,
      // The mapping's account binding is authoritative: a container monitored
      // through a specific account stays bound to it even when another account
      // also reports the same container id.
      ...(mapping.accountId === undefined ? {} : { accountId: mapping.accountId }),
      status: live.status,
      ...(live.url === undefined ? {} : { url: live.url }),
      ...(live.project === undefined ? {} : { project: live.project }),
      ...(live.createdAt === undefined
        ? mapping.createdAt === undefined
          ? {}
          : { createdAt: mapping.createdAt }
        : { createdAt: live.createdAt }),
      ...(live.updatedAt === undefined
        ? mapping.updatedAt === undefined
          ? {}
          : { updatedAt: mapping.updatedAt }
        : { updatedAt: live.updatedAt }),
      ...(live.log === undefined ? {} : { log: live.log })
    })
  }
  return merged
}

const PR_COMPOSE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' }
  }
} as const

const PR_COMPOSE_SYSTEM_PROMPT = [
  'You write pull request titles and descriptions from repository evidence supplied in the user message.',
  'Use only that evidence. Do not inspect the repository, call tools, ask questions, or perform Git operations.',
  'Return one JSON object with exactly the requested title and description fields.'
].join(' ')

function validatePrComposeInput(value: unknown): PrComposeInput {
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

function prComposePrompt(input: PrComposeInput, context: PullRequestComposeContext): string {
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
function prComposeResponse(response: AgentMessage): { title: string; description: string } {
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

function hasPrComposeResponse(response: AgentMessage): boolean {
  try {
    prComposeResponse(response)
    return true
  } catch {
    return false
  }
}

function prComposeRepairPrompt(response: AgentMessage, attempt: number): string {
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

const CANONICAL_ONLY_GLOBAL_SKILL_AGENTS = new Set(['opencode', 'codex', 'antigravity'])

/**
 * The Skills CLI classifies every agent whose skills folder is the canonical
 * `.agents/skills` as universal, and for a global install it writes the skill
 * straight into that canonical folder instead of linking it out to the agent's
 * own folder. Naming one universal agent is therefore how CodeInOven asks for
 * the global install the card promises: one folder in `~/.agents/skills` and
 * nothing else, rather than the CLI's `--agent '*'` fan-out, which drops a
 * symlink in every agent folder it knows about.
 */
const CANONICAL_SKILL_AGENT = 'codex'

/**
 * Skills CLI currently leaves universal agents in the canonical global folder
 * even for a named `--agent` install. Materialize the harness-advertised path
 * so OpenCode, Codex, and Antigravity can discover the selected skill there.
 */
async function materializeHarnessGlobalSkill(
  home: string,
  skillId: string,
  harnessId: string
): Promise<void> {
  if (!CANONICAL_ONLY_GLOBAL_SKILL_AGENTS.has(harnessId)) return
  const displayPath = harnessGlobalSkillPath(harnessId)
  if (!displayPath || displayPath === SHARED_GLOBAL_SKILL_PATH || !displayPath.startsWith('~/')) {
    return
  }
  const canonicalSkill = join(home, SHARED_GLOBAL_SKILL_PATH.slice(2), skillId)
  if (!existsSync(canonicalSkill)) return
  const harnessSkill = join(home, displayPath.slice(2), skillId)
  await mkdir(dirname(harnessSkill), { recursive: true })
  await cp(canonicalSkill, harnessSkill, { recursive: true, force: true, dereference: true })
}

const SKILL_MARKET_VIEWS = new Set(['all-time', 'trending', 'hot'])

interface EmbeddedSkillMarketEntry {
  source: string
  skillId: string
  name: string
  installs: number
  weeklyInstalls?: number[]
  installsYesterday?: number
  change?: number
  isOfficial?: boolean
}

function marketEntry(rawEntry: unknown): EmbeddedSkillMarketEntry | null {
  if (!isRecord(rawEntry)) return null
  const source = rawEntry['source']
  const skillId = rawEntry['skillId']
  const name = rawEntry['name']
  const installs = rawEntry['installs']
  if (
    typeof source !== 'string' ||
    typeof skillId !== 'string' ||
    typeof name !== 'string' ||
    typeof installs !== 'number'
  ) {
    return null
  }
  const weeklyInstalls = Array.isArray(rawEntry['weeklyInstalls'])
    ? rawEntry['weeklyInstalls'].filter((value): value is number => typeof value === 'number')
    : undefined
  return {
    source,
    skillId,
    name,
    installs,
    ...(weeklyInstalls?.length ? { weeklyInstalls } : {}),
    ...(typeof rawEntry['installsYesterday'] === 'number'
      ? { installsYesterday: rawEntry['installsYesterday'] }
      : {}),
    ...(typeof rawEntry['change'] === 'number' ? { change: rawEntry['change'] } : {}),
    ...(rawEntry['isOfficial'] === true ? { isOfficial: true } : {})
  }
}

function publicMarketEntry(entry: EmbeddedSkillMarketEntry) {
  const id = `${entry.source}/${entry.skillId}`
  return { id, ...entry, url: `https://www.skills.sh/${id}` }
}

async function fetchSkillMarketPage(pathname: string): Promise<string> {
  const response = await fetch(`https://www.skills.sh${pathname}`, {
    headers: { Accept: 'text/html', 'User-Agent': `${APP_NAME}/desktop` },
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error(`Skills market request failed (${response.status})`)
  return response.text()
}

function embeddedLeaderboard(html: string): EmbeddedSkillMarketEntry[] {
  const marker = 'initialSkills\\":'
  const start = html.indexOf(marker)
  const end = html.indexOf('],\\"totalSkills', start)
  if (start < 0 || end < 0) throw new Error('Skills market returned an invalid leaderboard')
  const encoded = html.slice(start + marker.length, end + 1)
  const parsed: unknown = JSON.parse(encoded.replaceAll('\\"', '"').replaceAll('\\\\', '\\'))
  if (!Array.isArray(parsed)) throw new Error('Skills market returned an invalid leaderboard')
  return parsed.flatMap((entry) => {
    const parsedEntry = marketEntry(entry)
    return parsedEntry ? [parsedEntry] : []
  })
}

function jsonLdSkill(html: string): { description: string; installs: number } | null {
  for (const match of html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/gu)) {
    try {
      const value: unknown = JSON.parse(match[1] ?? '')
      if (
        isRecord(value) &&
        value['@type'] === 'SoftwareApplication' &&
        typeof value['description'] === 'string' &&
        isRecord(value['interactionStatistic']) &&
        typeof value['interactionStatistic']['userInteractionCount'] === 'number'
      ) {
        return {
          description: value['description'],
          installs: value['interactionStatistic']['userInteractionCount']
        }
      }
    } catch {
      // Ignore unrelated malformed structured data and continue looking.
    }
  }
  return null
}

function skillDetailMetadata(html: string): {
  firstSeen: string | null
  audits: Array<{ name: string; status: 'pass' | 'warn' | 'fail' | 'unknown' }>
} {
  const firstSeen =
    html.match(/children\\":\\"First Seen\\"[\s\S]{0,600}?children\\":\\"([^"\\]+)\\"/u)?.[1] ??
    null
  const auditStart = html.indexOf('Security Audits')
  const auditText = auditStart >= 0 ? html.slice(auditStart, auditStart + 12_000) : ''
  const audits: Array<{ name: string; status: 'pass' | 'warn' | 'fail' | 'unknown' }> = []
  for (const match of auditText.matchAll(
    /text-foreground truncate">([^<]+)<\/span>[\s\S]{0,600}?>(Pass|Warn|Fail)<\/span>/gu
  )) {
    const name = match[1]
    const rawStatus = match[2]?.toLowerCase()
    if (!name || (rawStatus !== 'pass' && rawStatus !== 'warn' && rawStatus !== 'fail')) continue
    if (!audits.some((audit) => audit.name === name)) audits.push({ name, status: rawStatus })
  }
  for (const match of auditText.matchAll(
    /children\\":\\"([^"\\]+)\\"[\s\S]{0,500}?children\\":\\"(Pass|Warn|Fail)\\"/gu
  )) {
    const name = match[1]
    const rawStatus = match[2]?.toLowerCase()
    if (!name || (rawStatus !== 'pass' && rawStatus !== 'warn' && rawStatus !== 'fail')) continue
    if (!audits.some((audit) => audit.name === name)) audits.push({ name, status: rawStatus })
  }
  return { firstSeen, audits }
}

async function githubSkillMetadata(
  source: string,
  skillId: string
): Promise<{ repositoryUrl: string; stars: number | null; markdown: string }> {
  const repositoryUrl = `https://github.com/${source}`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `${APP_NAME}/desktop` }
  try {
    const [repositoryResponse, treeResponse] = await Promise.all([
      fetch(`https://api.github.com/repos/${source}`, {
        headers,
        signal: AbortSignal.timeout(20_000)
      }),
      fetch(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
        headers,
        signal: AbortSignal.timeout(20_000)
      })
    ])
    const repositoryPayload: unknown = repositoryResponse.ok
      ? await repositoryResponse.json()
      : null
    const treePayload: unknown = treeResponse.ok ? await treeResponse.json() : null
    const stars =
      isRecord(repositoryPayload) && typeof repositoryPayload['stargazers_count'] === 'number'
        ? repositoryPayload['stargazers_count']
        : null
    const defaultBranch =
      isRecord(repositoryPayload) && typeof repositoryPayload['default_branch'] === 'string'
        ? repositoryPayload['default_branch']
        : 'HEAD'
    const tree =
      isRecord(treePayload) && Array.isArray(treePayload['tree']) ? treePayload['tree'] : []
    const skillPath = tree
      .flatMap((entry) =>
        isRecord(entry) && typeof entry['path'] === 'string' ? [entry['path']] : []
      )
      .find((path) => path === `${skillId}/SKILL.md` || path.endsWith(`/${skillId}/SKILL.md`))
    let markdown = ''
    if (skillPath) {
      const rawResponse = await fetch(
        `https://raw.githubusercontent.com/${source}/${defaultBranch}/${skillPath}`,
        { headers: { 'User-Agent': `${APP_NAME}/desktop` }, signal: AbortSignal.timeout(20_000) }
      )
      if (rawResponse.ok) markdown = await rawResponse.text()
    }
    return { repositoryUrl, stars, markdown }
  } catch {
    return { repositoryUrl, stars: null, markdown: '' }
  }
}

const SKILL_MARKET_DETAIL_TTL_MS = 15 * 60 * 1_000
const SKILL_MARKET_DETAIL_CACHE_LIMIT = 100
const skillMarketDetailCache = new Map<string, { detail: SkillMarketDetail; fetchedAt: number }>()
const pendingSkillMarketDetails = new Map<string, Promise<SkillMarketDetail>>()

function skillMarketIdentity(rawId: unknown): {
  id: string
  source: string
  skillId: string
  segments: string[]
} {
  const id = validateBoundedString(rawId, 'Skill market ID', 3, 500)
  const segments = id.split('/').filter(Boolean)
  if (segments.length < 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/u.test(segment))) {
    throw new TypeError('Skill market ID is invalid')
  }
  return {
    id,
    source: segments.slice(0, -1).join('/'),
    skillId: segments.at(-1)!,
    segments
  }
}

async function loadSkillMarketDetail(rawId: unknown): Promise<SkillMarketDetail> {
  const identity = skillMarketIdentity(rawId)
  const cached = skillMarketDetailCache.get(identity.id)
  if (cached && Date.now() - cached.fetchedAt < SKILL_MARKET_DETAIL_TTL_MS) {
    return structuredClone(cached.detail)
  }
  const pending = pendingSkillMarketDetails.get(identity.id)
  if (pending) return structuredClone(await pending)

  const request = (async (): Promise<SkillMarketDetail> => {
    const githubSource = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(identity.source)
    const [html, github] = await Promise.all([
      fetchSkillMarketPage(`/${identity.segments.map(encodeURIComponent).join('/')}`),
      githubSource
        ? githubSkillMetadata(identity.source, identity.skillId)
        : Promise.resolve({ repositoryUrl: null, stars: null, markdown: '' })
    ])
    const structured = jsonLdSkill(html)
    if (!structured) throw new Error('Skills market returned an invalid skill page')
    const metadata = skillDetailMetadata(html)
    const detail: SkillMarketDetail = {
      ...publicMarketEntry({
        source: identity.source,
        skillId: identity.skillId,
        name: identity.skillId,
        installs: structured.installs
      }),
      description: structured.description,
      repositoryUrl: github.repositoryUrl,
      githubStars: github.stars,
      firstSeen: metadata.firstSeen,
      audits: metadata.audits,
      skillMarkdown: github.markdown
    }
    if (
      !skillMarketDetailCache.has(identity.id) &&
      skillMarketDetailCache.size >= SKILL_MARKET_DETAIL_CACHE_LIMIT
    ) {
      const oldestId = skillMarketDetailCache.keys().next().value
      if (oldestId) skillMarketDetailCache.delete(oldestId)
    }
    skillMarketDetailCache.set(identity.id, { detail, fetchedAt: Date.now() })
    return detail
  })().finally(() => pendingSkillMarketDetails.delete(identity.id))
  pendingSkillMarketDetails.set(identity.id, request)
  return structuredClone(await request)
}

function selectedIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new TypeError(`${label} must contain between 1 and 50 selections`)
  }
  return [...new Set(value.map((item) => validateEntityId(item, label.replace(/s$/u, ''), 256)))]
}

/** Resolve the native drag icon. Prefer the dragged file's own Finder icon so
 *  the drag ghost keeps the file's look; fall back to the app icon. */

export function registerCloudHandlers(ctx: IpcHandlerContext): void {
  const {
    storage,
    chatEngine,
    projectManager,
    checkpointManager,
    editorService,
    gitService,
    vault,
    githubAuthService,
    privileged,
    resolveProjectPath,
    providerForProject,
    pullRequestTarget
  } = ctx

  // ─── Cloud deployment config & credentials ────────────────────────────
  // The provider token is vaulted by main via `safeStorage` and never crosses
  // ─── Cloud deployment accounts & monitoring ────────────────────────────
  // Provider accounts live in a GLOBAL registry (task: reusable across
  // projects) and their tokens are vaulted by account id. A project's config
  // only records which accounts it attaches and which is active per provider.
  // The provider adapter is resolved by kind through the registry, and its
  // credential context (verified base URL + vaulted token) is assembled here
  // in main so plaintext tokens never cross the IPC boundary. A provider with
  // no attached configured account is rejected up front.
  const syncCloudDeploymentsFlag = async (projectId: string): Promise<void> => {
    const hasDeployments = await storage.hasCloudDeployments(projectId)
    await projectManager.setHasDeployments(projectId, hasDeployments).catch(() => undefined)
  }

  const loadOrCreateCloudDeploymentConfig = async (
    projectId: string
  ): Promise<CloudDeploymentConfig> => {
    const existing = await storage.getCloudDeploymentConfig(projectId)
    if (existing) return existing
    return {
      version: 3,
      projectId,
      project: { providers: [], containers: [] },
      updatedAt: Date.now()
    }
  }

  ipcMain.handle('cloudDeploy:getConfig', async (_, projectId: unknown) =>
    storage.getCloudDeploymentConfig(validateEntityId(projectId, 'Project ID'))
  )

  ipcMain.handle('cloudDeploy:saveConfig', async (_, projectId: unknown, rawConfig: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const safeConfig = validateCloudDeploymentConfig(rawConfig, safeProjectId)
    // Accounts live in the global registry; saveConfig only persists the
    // project's provider/container selection and account association. It can
    // never create or mutate account/credential state.
    await storage.saveCloudDeploymentConfig(safeProjectId, safeConfig)
    await syncCloudDeploymentsFlag(safeProjectId)
    return safeConfig
  })

  ipcMain.handle('cloudDeploy:clearConfig', async (_, projectId: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    await storage.clearCloudDeploymentConfig(safeProjectId)
    await syncCloudDeploymentsFlag(safeProjectId)
  })

  ipcMain.handle(
    'cloudDeploy:updateContainer',
    async (_, projectId: unknown, providerKind: unknown, containerId: unknown, patch: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID', true)
      if (!isRecord(patch)) throw new TypeError('Container update must be an object')

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const index = config.project.containers.findIndex(
        (mapping) => mapping.providerKind === kind && mapping.id === safeContainerId
      )
      if (index === -1) throw new TypeError('Container not found')

      const current = config.project.containers[index]
      const next: CloudDeploymentContainer = { ...current }
      if (patch.label !== undefined) {
        next.label = requireString(patch.label, 'Container label')
      }
      if (patch.id !== undefined) {
        const newId = requireString(patch.id, 'Container ID')
        if (
          config.project.containers.some(
            (mapping) => mapping.id === newId && mapping.id !== current.id
          )
        ) {
          throw new TypeError(`A container with id ${newId} is already configured`)
        }
        next.id = newId
      }
      config.project.containers = [...config.project.containers]
      config.project.containers[index] = next
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(safeProjectId, config)
      await syncCloudDeploymentsFlag(safeProjectId)
      return config
    }
  )

  ipcMain.handle(
    'cloudDeploy:removeContainer',
    async (_, projectId: unknown, providerKind: unknown, containerId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID', true)

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const remaining = config.project.containers.filter(
        (mapping) => !(mapping.providerKind === kind && mapping.id === safeContainerId)
      )
      if (remaining.length === config.project.containers.length) {
        throw new TypeError('Container not found')
      }
      config.project.containers = remaining
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(safeProjectId, config)
      await syncCloudDeploymentsFlag(safeProjectId)
      return config
    }
  )

  ipcMain.handle('cloudDeploy:listAccounts', async () => storage.getCloudDeploymentAccounts())

  ipcMain.handle(
    'cloudDeploy:createAccount',
    async (
      _,
      providerKind: unknown,
      accountLabel: unknown,
      token: unknown,
      rawBaseUrl?: unknown
    ) => {
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeLabel = validateAccountLabel(accountLabel)
      const safeToken = validateProviderToken(token)
      const baseUrl =
        rawBaseUrl === undefined ? undefined : validateProviderBaseUrl(rawBaseUrl, kind)

      const registry = await storage.getCloudDeploymentAccounts()
      if (registry.accounts.some((account) => account.label === safeLabel)) {
        throw new TypeError(`A provider account named "${safeLabel}" already exists`)
      }
      const accountId = randomUUID()
      const secretRef = await vault.saveProviderToken(accountId, safeToken)
      const now = Date.now()
      const account: CloudDeploymentProviderAccount = {
        id: accountId,
        label: safeLabel,
        providerKind: kind,
        secretRef,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        configured: true,
        enabled: true,
        createdAt: now,
        updatedAt: now
      }
      registry.accounts.push(account)
      await storage.saveCloudDeploymentAccounts(registry)
      // The secret is never returned to the renderer.
      return { ...account, secretRef: '' }
    }
  )

  /**
   * Update a global provider account's metadata: label, base URL, and enabled
   * state. The secret is handled by `cloudDeploy:rotateAccountSecret` and is
   * never touched here.
   */
  ipcMain.handle(
    'cloudDeploy:updateAccount',
    async (_, accountId: unknown, patch: unknown): Promise<CloudDeploymentProviderAccount> => {
      const safeAccountId = requireString(accountId, 'Account ID', true)
      if (!isRecord(patch)) throw new TypeError('Provider account update must be an object')
      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')

      if (patch.label !== undefined) {
        const safeLabel = validateAccountLabel(patch.label)
        if (
          registry.accounts.some((entry) => entry.id !== safeAccountId && entry.label === safeLabel)
        ) {
          throw new TypeError(`A provider account named "${safeLabel}" already exists`)
        }
        account.label = safeLabel
      }
      if (patch.baseUrl !== undefined) {
        account.baseUrl = validateProviderBaseUrl(patch.baseUrl, account.providerKind)
      }
      if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') {
          throw new TypeError('Provider account enabled flag must be a boolean')
        }
        account.enabled = patch.enabled
      }
      account.updatedAt = Date.now()
      await storage.saveCloudDeploymentAccounts(registry)
      return { ...account, secretRef: '' }
    }
  )

  ipcMain.handle(
    'cloudDeploy:rotateAccountSecret',
    async (_, accountId: unknown, token: unknown) => {
      const safeAccountId = requireString(accountId, 'Account ID', true)
      const safeToken = validateProviderToken(token)
      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')
      account.secretRef = await vault.saveProviderToken(safeAccountId, safeToken)
      account.configured = true
      account.updatedAt = Date.now()
      await storage.saveCloudDeploymentAccounts(registry)
      // The secret is update-only; never return it. Return the sanitized account.
      return { ...account, secretRef: '' }
    }
  )

  /**
   * Remove every trace of a provider account from one project's cloud
   * deployment config: its attachment, its active-account role, and every
   * container mapping monitored through it (explicitly bound mappings, plus
   * legacy unbound mappings for kinds where it was the active account).
   * Mirrors `cloudDeploy:detachAccount` cleanup so deleting an account
   * globally leaves no orphaned containers behind.
   */
  const pruneAccountFromCloudDeploymentConfig = async (accountId: string): Promise<void> => {
    for (const projectId of await storage.listDirectories('projects')) {
      const config = await storage.getCloudDeploymentConfig(projectId)
      const providerAccounts = config?.project.providerAccounts
      if (!config || !providerAccounts) continue
      let changed = false
      for (const key of Object.keys(providerAccounts) as CloudDeploymentProviderKind[]) {
        const association = providerAccounts[key]
        if (!association || !association.attachedAccountIds.includes(accountId)) continue
        const wasActive = association.activeAccountId === accountId
        const remaining = association.attachedAccountIds.filter((id) => id !== accountId)
        const containers = config.project.containers.filter((mapping) =>
          mapping.accountId !== undefined
            ? mapping.accountId !== accountId
            : // Legacy unbound mappings were monitored through the kind's
              // active account; they belong to the removed account when it was
              // active and must not silently reattach to another account.
              !(wasActive && mapping.providerKind === key)
        )
        if (containers.length !== config.project.containers.length) {
          config.project.containers = containers
        }
        if (remaining.length === 0) {
          delete providerAccounts[key]
          config.project.providers = config.project.providers.filter((provider) => provider !== key)
        } else {
          providerAccounts[key] = {
            attachedAccountIds: remaining,
            activeAccountId: wasActive ? (remaining[0] ?? null) : association.activeAccountId
          }
        }
        changed = true
      }
      if (!changed) continue
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(projectId, config)
      await syncCloudDeploymentsFlag(projectId)
    }
  }

  ipcMain.handle('cloudDeploy:removeAccount', async (_, accountId: unknown) => {
    const safeAccountId = requireString(accountId, 'Account ID', true)
    const registry = await storage.getCloudDeploymentAccounts()
    if (!registry.accounts.some((entry) => entry.id === safeAccountId)) {
      throw new TypeError('Provider account not found')
    }
    registry.accounts = registry.accounts.filter((entry) => entry.id !== safeAccountId)
    await storage.saveCloudDeploymentAccounts(registry)
    await vault.removeProviderToken(safeAccountId)
    // Detach the account from every project and drop the container mappings
    // monitored through it, so no project keeps polling (or erroring on) an
    // account that no longer exists.
    await pruneAccountFromCloudDeploymentConfig(safeAccountId)
  })

  ipcMain.handle(
    'cloudDeploy:attachAccount',
    async (_, projectId: unknown, providerKind: unknown, accountId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId = requireString(accountId, 'Account ID', true)

      const registry = await storage.getCloudDeploymentAccounts()
      const account = registry.accounts.find((entry) => entry.id === safeAccountId)
      if (!account) throw new TypeError('Provider account not found')
      if (account.providerKind !== kind) {
        throw new TypeError(`Account "${account.label}" is not a ${kind} account`)
      }

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const providerAccounts = config.project.providerAccounts ?? {}
      const association = providerAccounts[kind] ?? {
        attachedAccountIds: [],
        activeAccountId: null
      }
      if (association.attachedAccountIds.includes(safeAccountId)) {
        throw new TypeError(`Account is already attached for ${kind}`)
      }
      association.attachedAccountIds.push(safeAccountId)
      if (association.activeAccountId === null) {
        association.activeAccountId = safeAccountId
      }
      config.project.providerAccounts = { ...providerAccounts, [kind]: association }
      if (!config.project.providers.includes(kind)) {
        config.project.providers = [...config.project.providers, kind]
      }
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(safeProjectId, config)
      await syncCloudDeploymentsFlag(safeProjectId)
      return config
    }
  )

  ipcMain.handle(
    'cloudDeploy:detachAccount',
    async (_, projectId: unknown, providerKind: unknown, accountId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId = requireString(accountId, 'Account ID', true)

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const providerAccounts = config.project.providerAccounts ?? {}
      const association = providerAccounts[kind]
      if (!association || !association.attachedAccountIds.includes(safeAccountId)) {
        throw new TypeError(`Account is not attached for ${kind}`)
      }
      const remaining = association.attachedAccountIds.filter((id) => id !== safeAccountId)
      const wasActive = association.activeAccountId === safeAccountId
      // Container mappings monitored through the detached account stop here:
      // explicitly bound mappings go with the account, and legacy unbound
      // mappings for this kind were monitored through it while it was active
      // and must not silently reattach to another account.
      config.project.containers = config.project.containers.filter((mapping) =>
        mapping.accountId !== undefined
          ? mapping.accountId !== safeAccountId
          : !(wasActive && mapping.providerKind === kind)
      )
      if (remaining.length === 0) {
        delete providerAccounts[kind]
        config.project.providerAccounts = providerAccounts
        config.project.providers = config.project.providers.filter((provider) => provider !== kind)
      } else {
        providerAccounts[kind] = {
          attachedAccountIds: remaining,
          activeAccountId: wasActive ? (remaining[0] ?? null) : association.activeAccountId
        }
        config.project.providerAccounts = providerAccounts
      }
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(safeProjectId, config)
      await syncCloudDeploymentsFlag(safeProjectId)
      return config
    }
  )

  ipcMain.handle(
    'cloudDeploy:setActiveAccount',
    async (_, projectId: unknown, providerKind: unknown, accountId: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId = requireString(accountId, 'Account ID', true)

      const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
      const providerAccounts = config.project.providerAccounts ?? {}
      const association = providerAccounts[kind]
      if (!association || !association.attachedAccountIds.includes(safeAccountId)) {
        throw new TypeError(`Account is not attached for ${kind}`)
      }
      providerAccounts[kind] = { ...association, activeAccountId: safeAccountId }
      config.project.providerAccounts = providerAccounts
      config.updatedAt = Date.now()
      await storage.saveCloudDeploymentConfig(safeProjectId, config)
      await syncCloudDeploymentsFlag(safeProjectId)
      return config
    }
  )

  /**
   * Resolve the provider credential context for one project + provider kind.
   * When `accountId` is given it must be one of the project's attached accounts
   * for that kind (per-container account binding, so a second account of the
   * same kind keeps working independently of the active-account switch);
   * otherwise the project's active account for the kind is used.
   */
  const resolveDeploymentContext = async (
    projectId: string,
    kind: CloudDeploymentProviderKind,
    accountId?: string
  ): Promise<DeploymentProviderContext> => {
    const config = await storage.getCloudDeploymentConfig(projectId)
    const association = config?.project.providerAccounts?.[kind]
    const explicitAccountId = accountId ?? null
    if (
      explicitAccountId !== null &&
      !(association?.attachedAccountIds ?? []).includes(explicitAccountId)
    ) {
      throw new TypeError(`Cloud deployment account is not attached to this project for ${kind}`)
    }
    const activeAccountId = explicitAccountId ?? association?.activeAccountId ?? null
    const registry = activeAccountId === null ? null : await storage.getCloudDeploymentAccounts()
    const activeAccount =
      activeAccountId === null
        ? undefined
        : registry?.accounts.find((account) => account.id === activeAccountId)
    if (!activeAccount?.configured || !activeAccount.secretRef) {
      throw new TypeError(`Cloud deployment provider ${kind} is not configured for this project`)
    }
    if (!activeAccount.enabled) {
      throw new TypeError(`Cloud deployment account "${activeAccount.label}" is disabled`)
    }
    const token = await vault.resolveProviderToken(activeAccount.id)
    return {
      ...(activeAccount.baseUrl === undefined ? {} : { baseUrl: activeAccount.baseUrl }),
      token
    }
  }

  ipcMain.handle('cloudDeploy:overview', async (_, projectId: unknown, providerKind: unknown) => {
    const safeProjectId = validateEntityId(projectId, 'Project ID')
    const kind = validateCloudDeploymentProviderKind(providerKind)
    const hasDeployments = await storage.hasCloudDeployments(safeProjectId)
    const config = await loadOrCreateCloudDeploymentConfig(safeProjectId)
    // Every attached account for this kind contributes containers (active
    // first), so a second account of the same kind is monitored alongside the
    // first instead of being hidden behind the active-account switch.
    const association = config.project.providerAccounts?.[kind]
    const activeAccountId = association?.activeAccountId ?? null
    const attachedAccountIds = association?.attachedAccountIds ?? []
    const orderedAccountIds = [
      ...(activeAccountId !== null ? [activeAccountId] : []),
      ...attachedAccountIds.filter((accountId) => accountId !== activeAccountId)
    ]
    const registry = await storage.getCloudDeploymentAccounts()
    // Read-time guard for configs that still reference accounts deleted from
    // the global registry (e.g. removed before pruning existed): skip them and
    // the container mappings bound to them so dead accounts stop surfacing
    // errors or ghost containers.
    const knownAccountIds = new Set(registry.accounts.map((account) => account.id))
    const liveMappings = config.project.containers.filter(
      (mapping) => mapping.accountId === undefined || knownAccountIds.has(mapping.accountId)
    )
    const accountLabel = (accountId: string): string =>
      registry.accounts.find((account) => account.id === accountId)?.label ?? accountId

    if (orderedAccountIds.length === 0) {
      // Legacy shape: the kind is selected but no account association exists;
      // resolve through the single active-account path (its error surfaces).
      try {
        const provider = resolveDeploymentProvider(
          kind,
          await resolveDeploymentContext(safeProjectId, kind)
        )
        const liveContainers = await provider.listContainers()
        return {
          containers: mergeCloudDeploymentContainers(liveContainers, liveMappings, kind),
          fetchedAt: Date.now(),
          hasDeployments
        }
      } catch (error) {
        return {
          containers: [],
          fetchedAt: Date.now(),
          hasDeployments,
          accessError: error instanceof Error ? error.message : 'Provider request failed'
        }
      }
    }

    const fetchableAccountIds = orderedAccountIds.filter((accountId) =>
      knownAccountIds.has(accountId)
    )
    if (fetchableAccountIds.length === 0) {
      // Every attached account was deleted from the registry; report an empty
      // overview instead of erroring on accounts the user already removed.
      return { containers: [], fetchedAt: Date.now(), hasDeployments }
    }

    const liveContainers: CloudDeploymentContainer[] = []
    const failures: string[] = []
    await Promise.all(
      fetchableAccountIds.map(async (accountId) => {
        try {
          const provider = resolveDeploymentProvider(
            kind,
            await resolveDeploymentContext(safeProjectId, kind, accountId)
          )
          const containers = await provider.listContainers()
          liveContainers.push(...containers.map((container) => ({ ...container, accountId })))
        } catch (error) {
          const label = accountLabel(accountId)
          failures.push(
            `${label}: ${error instanceof Error ? error.message : 'Provider request failed'}`
          )
        }
      })
    )
    const containers = mergeCloudDeploymentContainers(liveContainers, liveMappings, kind)
    return {
      containers,
      fetchedAt: Date.now(),
      hasDeployments,
      ...(failures.length > 0 ? { accessError: failures.join(' · ') } : {})
    }
  })

  ipcMain.handle(
    'cloudDeploy:availableContainers',
    async (_, projectId: unknown, providerKind: unknown, accountId?: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      try {
        const provider = resolveDeploymentProvider(
          kind,
          await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
        )
        return await provider.listContainers()
      } catch (error) {
        return {
          accessError: error instanceof Error ? error.message : 'Provider request failed'
        }
      }
    }
  )

  ipcMain.handle(
    'cloudDeploy:containerStatus',
    async (
      _,
      projectId: unknown,
      providerKind: unknown,
      containerId: unknown,
      accountId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID')
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      const provider = resolveDeploymentProvider(
        kind,
        await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
      )
      return provider.getStatus(safeContainerId)
    }
  )

  ipcMain.handle(
    'cloudDeploy:containerLog',
    async (
      _,
      projectId: unknown,
      providerKind: unknown,
      containerId: unknown,
      deploymentId?: unknown,
      accountId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID')
      const safeDeploymentId =
        deploymentId === undefined ? undefined : requireString(deploymentId, 'Deployment ID')
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      const provider = resolveDeploymentProvider(
        kind,
        await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
      )
      const log = await provider.getLogs(safeContainerId, safeDeploymentId)
      return { containerId: safeContainerId, deploymentId: safeDeploymentId ?? null, log }
    }
  )

  ipcMain.handle(
    'cloudDeploy:deployments',
    async (
      _,
      projectId: unknown,
      providerKind: unknown,
      containerId: unknown,
      accountId?: unknown
    ) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const kind = validateCloudDeploymentProviderKind(providerKind)
      const safeContainerId = requireString(containerId, 'Container ID')
      const safeAccountId =
        accountId === undefined ? undefined : requireString(accountId, 'Account ID', true)
      const provider = resolveDeploymentProvider(
        kind,
        await resolveDeploymentContext(safeProjectId, kind, safeAccountId)
      )
      return provider.listDeployments(safeContainerId)
    }
  )

  ipcMain.handle(
    'pr:bundle',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      // Fetched together so the sidebar renders one complete view, not six
      // staggered ones. Optional surfaces degrade to empty rather than failing
      // the whole bundle (e.g. a repo with checks disabled).
      const [detail, commits, comments, reviews, reviewComments, files, checks] = await Promise.all(
        [
          provider.getPullRequest(target),
          provider.listPullRequestCommits(target).catch(() => []),
          provider.listPullRequestComments(target).catch(() => []),
          provider.listPullRequestReviews(target).catch(() => []),
          provider.listPullRequestReviewComments(target).catch(() => []),
          provider.listPullRequestFiles(target).catch(() => []),
          provider
            .getPullRequestChecks(target)
            .catch(() => ({ state: 'none' as const, checks: [] }))
        ]
      )
      return {
        detail,
        commits,
        comments,
        reviews,
        reviewComments,
        files,
        checks,
        fetchedAt: Date.now()
      }
    }
  )

  ipcMain.handle(
    'pr:commitFiles',
    async (_, projectId: unknown, owner: unknown, repo: unknown, sha: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      return provider.getCommitFiles(
        {
          owner: validateBoundedString(owner, 'PR owner', 1, 128),
          repo: validateBoundedString(repo, 'PR repository', 1, 128)
        },
        validateEntityId(sha, 'Commit sha')
      )
    }
  )

  ipcMain.handle(
    'pr:mentionUsers',
    async (_, projectId: unknown, owner: unknown, repo: unknown) => {
      const provider = await providerForProject(validateEntityId(projectId, 'Project ID'))
      if (!provider) throw new Error('Sign in to GitHub first (Git panel → GitHub account)')
      return provider.listRepositoryMentionUsers({
        owner: validateBoundedString(owner, 'PR owner', 1, 128),
        repo: validateBoundedString(repo, 'PR repository', 1, 128)
      })
    }
  )

  ipcMain.handle(
    'pr:detail',
    async (_, projectId: unknown, owner: unknown, repo: unknown, pullNumber: unknown) => {
      const {
        provider,
        owner: safeOwner,
        repo: safeRepo,
        pullNumber: safeNumber
      } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      try {
        return await provider.getPullRequest({
          owner: safeOwner,
          repo: safeRepo,
          pullNumber: safeNumber
        })
      } catch (reason) {
        // This channel powers the background mergeability probe, so transient
        // provider failures (timeouts, rate limits, flaky network) are expected.
        // Returning null avoids a noisy main-process "Error occurred in handler"
        // log for every probe retry; the caller already treats null as "unknown".
        Logger.dev('PR detail fetch failed', reason)
        return null
      }
    }
  )

  ipcMain.handle('pr:agentReport', async (_, projectId: unknown, pullNumber: unknown) => {
    const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
    const reportPath = join(
      projectPath,
      '.cio',
      'git',
      'pr',
      String(validatePrNumber(pullNumber)),
      'review.md'
    )
    const threadId = await readFile(join(dirname(reportPath), 'thread.json'), 'utf-8')
      .then((raw) => {
        const parsed: unknown = JSON.parse(raw)
        const value =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as Record<string, unknown>)['threadId']
            : null
        return typeof value === 'string' ? value : null
      })
      .catch(() => null)
    try {
      const [content, stats] = await Promise.all([readFile(reportPath, 'utf-8'), stat(reportPath)])
      return { path: reportPath, content, updatedAt: stats.mtimeMs, threadId }
    } catch {
      // No report yet   the agent hasn't finished (or hasn't been asked).
      return { path: reportPath, content: '', updatedAt: null, threadId }
    }
  })

  ipcMain.handle(
    'pr:comment',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      return runGitHubMutation(target.owner, target.repo, () =>
        provider.createPullRequestComment({
          ...target,
          body: validatePrCommentBody(body)
        })
      )
    }
  )

  ipcMain.handle(
    'pr:commentEdit',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      kind: unknown,
      commentId: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const comment = {
        ...target,
        kind: validatePrCommentKind(kind),
        commentId: validatePrCommentId(commentId)
      }
      const text = validatePrCommentBody(body)
      return runGitHubMutation(target.owner, target.repo, async () => {
        if (comment.kind === 'review') {
          await provider.updatePullRequestReviewComment({ ...comment, body: text })
        } else {
          await provider.updatePullRequestComment({ ...comment, body: text })
        }
        // The reader refetches the bundle either way, so the edited entity is not
        // worth serializing, only whether the write landed.
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:commentDelete',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      kind: unknown,
      commentId: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const comment = {
        ...target,
        kind: validatePrCommentKind(kind),
        commentId: validatePrCommentId(commentId)
      }
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.deletePullRequestComment(comment)
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:commentMinimize',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      nodeId: unknown,
      reason: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const id = validateGraphqlNodeId(nodeId)
      const classifier = validatePrMinimizeReason(reason)
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.minimizePullRequestComment({ nodeId: id, reason: classifier })
        return true
      })
    }
  )

  ipcMain.handle(
    'pr:review',
    async (
      _,
      projectId: unknown,
      owner: unknown,
      repo: unknown,
      pullNumber: unknown,
      event: unknown,
      body: unknown
    ) => {
      const { provider, ...target } = await pullRequestTarget(projectId, owner, repo, pullNumber)
      const verdict = validatePrReviewEvent(event)
      const text = validatePrCommentBody(body, true)
      // GitHub rejects a REQUEST_CHANGES or COMMENT review without a body.
      if (verdict !== 'APPROVE' && !text.trim()) {
        throw new Error('Leave a comment explaining the requested changes')
      }
      return runGitHubMutation(target.owner, target.repo, async () => {
        await provider.createPullRequestReview({ ...target, event: verdict, body: text })
        return null
      })
    }
  )

  ipcMain.handle(
    'pr:reviewWorkspace',
    async (_, projectId: unknown, pullNumber: unknown, threadId?: unknown) => {
      const projectPath = await resolveProjectPath(validateEntityId(projectId, 'Project ID'))
      const directory = join(projectPath, '.cio', 'git', 'pr', String(validatePrNumber(pullNumber)))
      await mkdir(directory, { recursive: true })
      if (threadId !== undefined) {
        // Remember which thread owns this review so the sidebar can jump back
        // into the conversation after a restart.
        await writeFile(
          join(directory, 'thread.json'),
          JSON.stringify({ threadId: validateEntityId(threadId, 'Thread ID') }, null, 2),
          'utf-8'
        )
      }
      return directory
    }
  )

  ipcMain.handle('pr:composeWithAgent', async (_, ...args: unknown[]) => {
    if (!chatEngine?.runVirtualTask) throw new Error('The PR compose agent is unavailable')
    const safeProjectId = validateEntityId(args[0], 'Project ID')
    const scopeBucketId = validateEntityId(args[1], 'Scope bucket ID')
    const virtualTaskId = validateEntityId(args[2], 'Virtual task ID')
    const requestedSettings = validateThreadSettings(args[3])
    const settings = validateThreadSettings({
      harnessId: requestedSettings.harnessId,
      providerId: requestedSettings.providerId,
      modelId: requestedSettings.modelId,
      thinkingLevel: requestedSettings.thinkingLevel,
      inferenceMode: 'normal',
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false,
      fileSystemMode: false
    })
    const input = validatePrComposeInput(args[4])
    const context = await gitService.pullRequestComposeContext(
      await resolveProjectPath(safeProjectId, scopeBucketId),
      input
    )
    const response = await chatEngine.runVirtualTask(
      safeProjectId,
      virtualTaskId,
      settings,
      `Compose PR: ${input.head} to ${input.base}`,
      prComposePrompt(input, context),
      {
        systemPrompt: PR_COMPOSE_SYSTEM_PROMPT,
        readOnly: true,
        allowedTools: [],
        structuredOutput: { schema: PR_COMPOSE_OUTPUT_SCHEMA, retryCount: 2 },
        textOutputFallback: {
          accepts: hasPrComposeResponse,
          repairPrompt: prComposeRepairPrompt
        }
      }
    )
    const report = prComposeResponse(response)
    if (!report.title.trim()) throw new Error('The PR compose agent returned no title')
    return {
      ...report,
      taskId: virtualTaskId
    }
  })

  ipcMain.handle('utilities:setupWithAgent', async (_, ...args: unknown[]) => {
    if (!chatEngine?.runVirtualTask) throw new Error('The utility setup agent is unavailable')
    const projectId = validateEntityId(args[0], 'Project ID')
    const taskId = validateEntityId(args[1], 'Virtual task ID')
    const settings = validateThreadSettings({
      ...validateThreadSettings(args[2]),
      permissionLevel: 'auto_review',
      assignmentMode: false,
      loopMode: false
    })
    const request = validateBoundedString(args[3], 'Utility setup request', 1, 100_000)
    await resolveProjectPath(projectId)
    const registry = new UtilityRegistryService(storage)
    const beforeIds = new Set((await registry.list()).map((utility) => utility.id))
    const response = await chatEngine.runVirtualTask(
      projectId,
      taskId,
      settings,
      'Set up utility',
      request,
      { utilityManagement: true }
    )
    const installed = (await registry.list()).filter((utility) => !beforeIds.has(utility.id))
    const summary = response.parts
      .flatMap((part) => (part.type === 'text' && part.phase !== 'commentary' ? [part.text] : []))
      .join('\n\n')
      .trim()
    if (installed.length === 0) {
      throw new Error(summary || 'The setup agent did not install a utility')
    }
    return { taskId, summary, installed }
  })

  ipcMain.handle('utilities:searchSkillMarket', async (_, rawQuery: unknown) => {
    const query = validateBoundedString(rawQuery, 'Skill search query', 2, 200)
    const url = new URL('https://www.skills.sh/api/search')
    url.searchParams.set('q', query)
    url.searchParams.set('limit', '50')
    const response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': `${APP_NAME}/desktop` },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`Skills market search failed (${response.status})`)
    const payload: unknown = await response.json()
    if (!isRecord(payload) || !Array.isArray(payload['skills'])) {
      throw new Error('Skills market returned an invalid response')
    }
    const entries = payload['skills'].flatMap((rawEntry) => {
      if (!isRecord(rawEntry)) return []
      const id = rawEntry['id']
      const skillId = rawEntry['skillId']
      const name = rawEntry['name']
      const source = rawEntry['source']
      const installs = rawEntry['installs']
      if (
        typeof id !== 'string' ||
        typeof skillId !== 'string' ||
        typeof name !== 'string' ||
        typeof source !== 'string' ||
        typeof installs !== 'number'
      ) {
        return []
      }
      return [
        {
          id,
          skillId,
          name,
          source,
          installs,
          url: `https://www.skills.sh/${id}`
        }
      ]
    })
    return { query, entries }
  })

  ipcMain.handle('utilities:listSkillMarket', async (_, rawView: unknown) => {
    if (typeof rawView !== 'string' || !SKILL_MARKET_VIEWS.has(rawView)) {
      throw new TypeError('Skill market view is invalid')
    }
    const pathname = rawView === 'all-time' ? '/' : `/${rawView}`
    const entries = embeddedLeaderboard(await fetchSkillMarketPage(pathname))
      .slice(0, 100)
      .map(publicMarketEntry)
    return { view: rawView as 'all-time' | 'trending' | 'hot', entries }
  })

  ipcMain.handle('utilities:getSkillMarketDetail', (_, rawId: unknown) =>
    loadSkillMarketDetail(rawId)
  )

  ipcMain.handle('utilities:installMarketSkill', async (_, rawRequest: unknown) => {
    if (!isRecord(rawRequest)) throw new TypeError('Skill install request must be an object')
    const source = validateBoundedString(rawRequest['source'], 'Skill source', 3, 300)
    const skillId = validateEntityId(rawRequest['skillId'], 'Skill ID', 200)
    const githubSource = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source)
    const wellKnownSource = /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/u.test(source)
    if (!githubSource && !wellKnownSource) throw new TypeError('Skill source is invalid')
    const installSource = githubSource ? `https://github.com/${source}` : `https://${source}`
    const manager = rawRequest['manager']
    if (manager !== 'cio' && manager !== 'native') {
      throw new TypeError('Select who should manage this skill')
    }
    const scope = rawRequest['scope']
    if (!isRecord(scope)) throw new TypeError('Skill install scope must be an object')
    const scopeKind = scope['kind']
    if (scopeKind !== 'global' && scopeKind !== 'projects' && scopeKind !== 'harnesses') {
      throw new TypeError('Select global, project, or harness installation')
    }
    const projectIds =
      scopeKind === 'projects' ? selectedIds(scope['projectIds'], 'Project IDs') : []
    const projectPaths = new Map<string, string>()
    for (const projectId of projectIds) {
      projectPaths.set(projectId, await resolveProjectPath(projectId))
    }

    if (manager === 'cio') {
      if (scopeKind === 'harnesses') {
        throw new TypeError('CodeInOven-managed skills support global or project scope')
      }
      const activation = rawRequest['activation']
      if (activation !== 'always' && activation !== 'on_demand') {
        throw new TypeError('Select always available or on-demand activation')
      }
      const detail = await loadSkillMarketDetail(`${source}/${skillId}`)
      if (!detail.skillMarkdown.trim()) {
        throw new Error('This source does not expose a readable SKILL.md for CodeInOven to manage')
      }
      const scopes =
        scopeKind === 'global'
          ? [{ level: 'global' } as const]
          : projectIds.map((projectId) => ({ level: 'project' as const, projectId }))
      const definitions: UtilityDefinitionInput<'skill'>[] = scopes.map((utilityScope) => ({
        kind: 'skill',
        name: detail.name,
        description: detail.description,
        enabled: true,
        activation,
        scope: utilityScope,
        config: { instructions: detail.skillMarkdown },
        harnessBindings: [
          {
            harnessId: '*',
            strategy: 'skill',
            transportName: skillId
          }
        ]
      }))
      const registry = new UtilityRegistryService(storage)
      // Reinstalling the same skill updates its entry and clears any extra copies,
      // so the market cannot leave two entries competing for one name.
      const outcomes = await registry.installMany(definitions, { consolidate: true })
      const added = outcomes.filter((outcome) => outcome.action === 'installed').length
      const updated = outcomes.length - added
      const removed = outcomes.reduce((count, outcome) => count + outcome.removed.length, 0)
      const skill = (count: number) => `skill${count === 1 ? '' : 's'}`
      const parts = [
        added > 0 ? `Added ${added} CodeInOven-managed ${skill(added)}` : '',
        updated > 0 ? `updated ${updated} existing ${skill(updated)}` : '',
        removed > 0 ? `removed ${removed} duplicate ${skill(removed)}` : ''
      ].filter(Boolean)
      return parts.join(', ')
    }

    const knownHarnesses = new Set(listHarnesses().map((harness) => harness.id))
    // Each scope installs into the destination the card advertises and nowhere
    // else: a global install is the canonical `~/.agents/skills` folder, a
    // project install is that project's own `.agents/skills` folder, and a
    // harness install is the folders of the harnesses that were picked.
    let agentTargets = [CANONICAL_SKILL_AGENT]
    if (scopeKind === 'harnesses') {
      agentTargets = selectedIds(scope['harnessIds'], 'Harness IDs')
      if (agentTargets.some((harnessId) => !knownHarnesses.has(harnessId))) {
        throw new TypeError('Select only supported harnesses')
      }
    }
    const destinations =
      scopeKind === 'projects'
        ? projectIds.map((projectId) => projectPaths.get(projectId)!)
        : [app.getPath('home')]
    const outputs: string[] = []
    for (const directory of destinations) {
      for (const agentTarget of agentTargets) {
        outputs.push(
          await runSkillsCli(
            [
              'add',
              installSource,
              '--skill',
              skillId,
              '--agent',
              agentTarget,
              // Real folders instead of symlinks back to a canonical copy, so an
              // uninstall can never leave a dangling link behind.
              '--copy',
              '-y',
              ...(scopeKind === 'projects' ? [] : ['--global'])
            ],
            directory
          )
        )
        if (scopeKind === 'harnesses') {
          await materializeHarnessGlobalSkill(directory, skillId, agentTarget)
        }
      }
    }
    return outputs.filter(Boolean).at(-1) ?? `Installed to ${destinations.length} destination(s)`
  })

  /** Projects a native skill scan can look into: local ones with a real path. */
  const skillScanProjects = async (): Promise<Array<{ id: string; name: string; path: string }>> =>
    (await projectManager.listProjects())
      .filter((project) => project.source !== 'ssh' && Boolean(project.path))
      .map((project) => ({ id: project.id, name: project.name, path: project.path }))

  ipcMain.handle('utilities:installedSkillLocations', async () =>
    listInstalledSkillLocations(storage, await skillScanProjects())
  )

  ipcMain.handle('utilities:uninstallMarketSkill', async (_, rawSkillId: unknown) => {
    const skillId = validateEntityId(rawSkillId, 'Skill ID', 200)
    return uninstallMarketSkill(storage, skillId, await skillScanProjects(), app.getPath('home'))
  })

  ipcMain.handle('github:authStatus', () => githubAuthService.status())
  ipcMain.handle('github:startDeviceFlow', () => githubAuthService.startDeviceFlow())
  ipcMain.handle('github:poll', async (_, deviceCode: unknown) =>
    githubAuthService.pollAccessToken(validateBoundedString(deviceCode, 'Device code', 1, 256))
  )
  ipcMain.handle('github:logout', async () => {
    await githubAuthService.logout()
    return githubAuthService.status()
  })

  ipcMain.handle('checkpoint:list', (_, projectId: string, threadId: string) =>
    checkpointManager.listSummaries(projectId, threadId)
  )
  ipcMain.handle('checkpoint:activeSummary', async (_, projectId: string, threadId: string) => {
    if (!chatEngine?.activeTurnChangeSummary) return null
    return chatEngine.activeTurnChangeSummary(projectId, threadId)
  })
  ipcMain.handle(
    'checkpoint:liveDiff',
    (_, projectId: unknown, threadId: unknown, checkpointId: unknown, path: unknown) =>
      checkpointManager.getLiveFileDiff(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(checkpointId, 'Checkpoint ID'),
        requireString(path, 'Checkpoint path')
      )
  )
  ipcMain.handle(
    'checkpoint:diff',
    (_, projectId: unknown, threadId: unknown, checkpointId: unknown, path: unknown) =>
      checkpointManager.getFileDiff(
        validateEntityId(projectId, 'Project ID'),
        validateEntityId(threadId, 'Thread ID'),
        validateEntityId(checkpointId, 'Checkpoint ID'),
        requireString(path, 'Checkpoint path')
      )
  )
  ipcMain.handle(
    'checkpoint:rollback',
    async (_, projectId: string, threadId: string, checkpointId: string) => {
      await checkpointManager.rollback(projectId, threadId, checkpointId)
      return checkpointManager.listSummaries(projectId, threadId)
    }
  )
  ipcMain.handle(
    'checkpoint:rollbackPaths',
    async (_, projectId: unknown, threadId: unknown, checkpointId: unknown, paths: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      await checkpointManager.rollbackPaths(
        safeProjectId,
        safeThreadId,
        validateEntityId(checkpointId, 'Checkpoint ID'),
        validateStringArray(paths, 'Checkpoint paths')
      )
      return checkpointManager.listSummaries(safeProjectId, safeThreadId)
    }
  )
  ipcMain.handle(
    'checkpoint:redoPaths',
    async (_, projectId: unknown, threadId: unknown, checkpointId: unknown, paths: unknown) => {
      const safeProjectId = validateEntityId(projectId, 'Project ID')
      const safeThreadId = validateEntityId(threadId, 'Thread ID')
      await checkpointManager.redoPaths(
        safeProjectId,
        safeThreadId,
        validateEntityId(checkpointId, 'Checkpoint ID'),
        validateStringArray(paths, 'Checkpoint paths')
      )
      return checkpointManager.listSummaries(safeProjectId, safeThreadId)
    }
  )
  privileged('project:openInEditor', async (_event, projectId: string) => {
    const project = await projectManager.getProject(projectId)
    if (!project?.path) return

    const config = await storage.getConfig()
    await editorService.openInEditor(config.preferredEditor, project.path)
  })
}
