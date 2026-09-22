import { existsSync } from 'node:fs'
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { harnessGlobalSkillPath, SHARED_GLOBAL_SKILL_PATH } from '../../lib/native-skill-paths'
import type { UtilityActivation, UtilityDefinitionInput } from '../../lib/types'
import { listHarnesses } from '../agents/harness-registry'
import type { StorageEngine } from '../storage/storage-engine'
import { loadSkillMarketDetail } from './skill-market'
import {
  SkillInstallRecordStore,
  skillInstallRecordId,
  type SkillInstallRecordInput
} from './skill-install-records'
import { fetchUpstreamSkillVersion } from './skill-upstream'
import { runSkillsCli } from './skills-cli'
import { UtilityRegistryService } from './utility-registry-service'

/**
 * The one routine that puts a marketplace skill where the install card says.
 *
 * Install and update both go through it, so a background update can never land
 * a skill somewhere the card does not advertise, and the install record it
 * writes is what makes the updater own exactly the copies CodeInOven placed.
 */

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

/** A marketplace source CodeInOven can resolve through the GitHub tree API. */
export function isGithubSkillSource(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source)
}

/** A marketplace source served by a domain's well-known skills index. */
export function isWellKnownSkillSource(source: string): boolean {
  return /^(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/u.test(source)
}

/** Harnesses the machine can drive right now, by id. */
export function knownHarnessIds(): Set<string> {
  return new Set(listHarnesses().map((harness) => harness.id))
}

export type MarketSkillScope = 'global' | 'projects' | 'harnesses'

/** A fully validated install request, from the IPC handler or the updater. */
export interface MarketSkillInstallRequest {
  source: string
  skillId: string
  manager: 'cio' | 'native'
  scope: MarketSkillScope
  projectIds: string[]
  harnessIds: string[]
  activation?: UtilityActivation
}

export interface MarketSkillInstallContext {
  storage: StorageEngine
  home: string
  resolveProjectPath: (projectId: string) => Promise<string>
  /** GitHub token for rate limits and private sources, when the user is signed in. */
  githubToken?: () => Promise<string | null>
}

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

/** Record every copy this install just placed, so the updater can keep it fresh. */
async function recordInstall(
  context: MarketSkillInstallContext,
  request: MarketSkillInstallRequest,
  copies: Array<{
    scope: 'global' | 'project' | 'harness'
    projectId?: string
    harnessIds?: string[]
  }>
): Promise<string[]> {
  const records: SkillInstallRecordInput[] = copies.map((copy) => ({
    skillId: request.skillId,
    manager: request.manager,
    source: request.source,
    sourceType: isGithubSkillSource(request.source) ? 'github' : 'well-known',
    scope: copy.scope,
    ...(copy.projectId ? { projectId: copy.projectId } : {}),
    ...(copy.harnessIds?.length ? { harnessIds: copy.harnessIds } : {}),
    ...(request.activation ? { activation: request.activation } : {})
  }))
  await new SkillInstallRecordStore(context.storage).upsert(records)
  return records.map((record) =>
    skillInstallRecordId(record.manager, record.skillId, record.scope, record.projectId)
  )
}

/** Install a CodeInOven-managed copy: content in the registry, nothing on disk. */
async function installManagedSkill(
  context: MarketSkillInstallContext,
  request: MarketSkillInstallRequest
): Promise<string> {
  if (request.scope === 'harnesses') {
    throw new TypeError('CodeInOven-managed skills support global or project scope')
  }
  const activation = request.activation
  if (activation !== 'always' && activation !== 'on_demand') {
    throw new TypeError('Select always available or on-demand activation')
  }
  const detail = await loadSkillMarketDetail(`${request.source}/${request.skillId}`)
  if (!detail.skillMarkdown.trim()) {
    throw new Error('This source does not expose a readable SKILL.md for CodeInOven to manage')
  }
  // A project-scoped skill is only usable if the project is really there, so the
  // install fails loudly instead of registering content nothing can resolve.
  for (const projectId of request.projectIds) {
    await context.resolveProjectPath(projectId)
  }
  const scopes =
    request.scope === 'global'
      ? [{ level: 'global' } as const]
      : request.projectIds.map((projectId) => ({ level: 'project' as const, projectId }))
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
        transportName: request.skillId
      }
    ]
  }))
  const registry = new UtilityRegistryService(context.storage)
  // Reinstalling the same skill updates its entry and clears any extra copies,
  // so the market cannot leave two entries competing for one name.
  const outcomes = await registry.installMany(definitions, { consolidate: true })
  await recordInstall(
    context,
    request,
    scopes.map((scope) =>
      scope.level === 'global'
        ? { scope: 'global' as const }
        : { scope: 'project' as const, projectId: scope.projectId }
    )
  )
  const added = outcomes.filter((outcome) => outcome.action === 'installed').length
  const updated = outcomes.length - added
  const removed = outcomes.reduce((count, outcome) => count + outcome.removed.length, 0)
  const skill = (count: number) => `skill${count === 1 ? '' : 's'}`
  return [
    added > 0 ? `Added ${added} CodeInOven-managed ${skill(added)}` : '',
    updated > 0 ? `updated ${updated} existing ${skill(updated)}` : '',
    removed > 0 ? `removed ${removed} duplicate ${skill(removed)}` : ''
  ]
    .filter(Boolean)
    .join(', ')
}

/** Install a native copy through the Skills CLI, which owns that layout. */
async function installNativeSkill(
  context: MarketSkillInstallContext,
  request: MarketSkillInstallRequest
): Promise<{ summary: string; recordIds: string[] }> {
  const knownHarnesses = knownHarnessIds()
  // Each scope installs into the destination the card advertises and nowhere
  // else: a global install is the canonical `~/.agents/skills` folder, a
  // project install is that project's own `.agents/skills` folder, and a
  // harness install is the folders of the harnesses that were picked.
  let agentTargets = [CANONICAL_SKILL_AGENT]
  if (request.scope === 'harnesses') {
    agentTargets = request.harnessIds
    if (agentTargets.some((harnessId) => !knownHarnesses.has(harnessId))) {
      throw new TypeError('Select only supported harnesses')
    }
  }
  const projectPaths = new Map<string, string>()
  for (const projectId of request.projectIds) {
    projectPaths.set(projectId, await context.resolveProjectPath(projectId))
  }
  const destinations =
    request.scope === 'projects'
      ? request.projectIds.map((projectId) => projectPaths.get(projectId)!)
      : [context.home]
  const installSource = isGithubSkillSource(request.source)
    ? `https://github.com/${request.source}`
    : `https://${request.source}`
  const githubToken = (await context.githubToken?.().catch(() => null)) ?? null
  const outputs: string[] = []
  for (const directory of destinations) {
    for (const agentTarget of agentTargets) {
      outputs.push(
        await runSkillsCli(
          [
            'add',
            installSource,
            '--skill',
            request.skillId,
            '--agent',
            agentTarget,
            // Real folders instead of symlinks back to a canonical copy, so an
            // uninstall can never leave a dangling link behind.
            '--copy',
            '-y',
            ...(request.scope === 'projects' ? [] : ['--global'])
          ],
          directory,
          { githubToken }
        )
      )
      if (request.scope === 'harnesses') {
        await materializeHarnessGlobalSkill(directory, request.skillId, agentTarget)
      }
    }
  }
  const recordIds = await recordInstall(
    context,
    request,
    request.scope === 'projects'
      ? request.projectIds.map((projectId) => ({ scope: 'project' as const, projectId }))
      : request.scope === 'harnesses'
        ? [{ scope: 'harness' as const, harnessIds: [...agentTargets] }]
        : [{ scope: 'global' as const }]
  )
  return {
    summary: outputs.filter(Boolean).at(-1) ?? `Installed to ${destinations.length} destination(s)`,
    recordIds
  }
}

/** Install one marketplace skill where the card says, and record what was placed. */
export async function installMarketSkill(
  context: MarketSkillInstallContext,
  request: MarketSkillInstallRequest
): Promise<string> {
  if (request.manager === 'cio') return installManagedSkill(context, request)
  const { summary, recordIds } = await installNativeSkill(context, request)
  // Capture what upstream held at this moment, so the next background pass can
  // tell whether the skill moved. The skills CLI writes this hash only into its
  // global lock, and a project lock has no comparable value at all, so the
  // record is the one place both scopes can compare against.
  const githubToken = (await context.githubToken?.().catch(() => null)) ?? null
  const upstream = await fetchUpstreamSkillVersion({
    source: request.source,
    sourceType: isGithubSkillSource(request.source) ? 'github' : 'well-known',
    skillId: request.skillId,
    githubToken
  }).catch(() => null)
  if (upstream) {
    await new SkillInstallRecordStore(context.storage).setUpstream(recordIds, upstream)
  }
  return summary
}
