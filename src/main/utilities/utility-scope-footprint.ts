import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Dirent } from 'node:fs'
import type {
  McpUtilityConfig,
  UtilityDefinition,
  UtilityKind,
  UtilityScope
} from '../../lib/types'
import { CIO_SCRATCH_DIRECTORY } from '../../lib/cio-cleanup'
import {
  CONFIG_UTILITIES_DIRECTORY,
  MCP_INSTALL_FILE,
  PROJECT_UTILITIES_DIRECTORY,
  SKILL_INSTALL_FILE,
  THREAD_UTILITIES_DIRECTORY,
  UTILITY_INSTALL_MANIFEST,
  UTILITY_INSTALL_MANIFEST_VERSION,
  utilityInstallFolderName
} from '../../lib/utility-scope-paths'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'

/**
 * The on-disk install of a scoped utility.
 *
 * A utility the user scoped to a project or a thread is not only a registry
 * entry: it is installed as a real folder in the place that scope names, so the
 * install is visible and inspectable instead of existing only inside app state.
 * This service owns that folder: it writes the files, keeps them in step with
 * the registry entry, and removes them when the utility, its scope, or the
 * thread they belong to goes away.
 *
 * Only skills and MCP servers are installed on disk. Every other kind is a
 * capability the app itself answers (a web tool, the browser, a provider), so it
 * has no files to place. App-owned entries are never installed either: they ship
 * with the app and belong to every scope at once.
 */

/** What one install folder says about itself, so the folder is self-explaining. */
interface UtilityInstallManifest {
  version: number
  /** Registry entry that owns this folder. */
  id: string
  kind: UtilityKind
  name: string
  scope: 'project' | 'thread'
  projectId?: string
  threadId?: string
  /** Credential variables the utility expects, never their values. */
  credentialVariables: string[]
  updatedAt: number
}

export interface UtilityScopeFootprintDeps {
  /** Absolute working directory of a project, or null when it cannot be resolved. */
  resolveProjectPath(projectId: string): Promise<string | null>
  /**
   * Local checkouts a project install could already live in. Supplied by the
   * passes that sweep the whole registry (startup, marketplace installs) so a
   * folder an uninstalled utility left behind is still found; a targeted write
   * names the scope it may have left instead.
   */
  listProjectPaths?(): Promise<ReadonlyArray<{ id: string; path: string }>>
}

/** How much ground one reconcile pass covers. */
export interface UtilityReconcileOptions {
  /**
   * Scopes the caller knows are no longer installed: a utility's previous scope
   * when it moved, or its scope when it was deleted. Their roots are swept even
   * though no registry entry points at them any more.
   */
  pruneScopes?: readonly UtilityScope[]
}

/** A utility whose scope puts it on disk at all. */
export function isInstalledUtility(utility: UtilityDefinition): boolean {
  if (utility.appOwned || utility.scope.level === 'global') return false
  return utility.kind === 'skill' || utility.kind === 'mcp'
}

function manifestFor(utility: UtilityDefinition): UtilityInstallManifest {
  const scope = utility.scope
  return {
    version: UTILITY_INSTALL_MANIFEST_VERSION,
    id: utility.id,
    kind: utility.kind,
    name: utility.name,
    scope: scope.level === 'thread' ? 'thread' : 'project',
    ...(scope.level === 'global' ? {} : { projectId: scope.projectId }),
    ...(scope.level === 'thread' ? { threadId: scope.threadId } : {}),
    credentialVariables: utility.credentials
      .map((credential) => credential.environmentVariable ?? '')
      .filter(Boolean)
      .sort(),
    updatedAt: utility.updatedAt
  }
}

/** The folder name a utility prefers: its marketplace id or a slug of its name. */
function preferredFolderName(utility: UtilityDefinition): string {
  const transportName = utility.harnessBindings
    .map((binding) => binding.transportName ?? '')
    .find((name) => name.trim() !== '')
  return utilityInstallFolderName(utility.name, transportName)
}

/** The connection an MCP install writes; credential values never reach a file. */
function mcpConnection(utility: UtilityDefinition): McpUtilityConfig | null {
  if (utility.kind !== 'mcp') return null
  const { transport, command, args, url, environment, headers } = utility.config
  return {
    transport,
    ...(command ? { command } : {}),
    ...(args?.length ? { args } : {}),
    ...(url ? { url } : {}),
    ...(environment && Object.keys(environment).length > 0 ? { environment } : {}),
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {})
  }
}

export class UtilityScopeFootprintService {
  constructor(
    private readonly storage: StorageEngine,
    private readonly deps: UtilityScopeFootprintDeps
  ) {}

  /**
   * Absolute folder a utility's own install belongs in, or null when nothing
   * should be installed: a global scope, a kind with no files, or a project the
   * app cannot resolve right now.
   */
  private async rootFor(scope: UtilityScope): Promise<string | null> {
    if (scope.level === 'global') return null
    if (scope.level === 'thread') {
      return join(
        this.storage.resolve(CONFIG_UTILITIES_DIRECTORY),
        THREAD_UTILITIES_DIRECTORY,
        scope.threadId
      )
    }
    const projectPath = await this.deps.resolveProjectPath(scope.projectId).catch(() => null)
    if (!projectPath) return null
    return join(projectPath, CIO_SCRATCH_DIRECTORY, PROJECT_UTILITIES_DIRECTORY)
  }

  /** Write one utility's install, and drop a stale folder it left in its root. */
  async install(utility: UtilityDefinition): Promise<string | null> {
    if (!isInstalledUtility(utility)) return null
    try {
      const root = await this.rootFor(utility.scope)
      if (!root) return null
      const folders = await this.resolveFolders(root, [utility])
      const folder = folders.get(utility.id)
      if (!folder) return null
      await this.installInto(root, folder, utility)
      return join(root, folder)
    } catch (error) {
      Logger.dev('Utility install folder could not be written:', error)
      return null
    }
  }

  /**
   * Make disk match the registry: every scoped skill and MCP server is written
   * where it belongs, and a folder whose utility is no longer installed is
   * removed. This is also the pass that gives scoped entries installed before
   * this feature existed their files.
   */
  async reconcile(
    utilities: readonly UtilityDefinition[],
    options: UtilityReconcileOptions = {}
  ): Promise<void> {
    const groups = new Map<string, { root: string; members: UtilityDefinition[] }>()
    for (const utility of utilities.filter(isInstalledUtility)) {
      const root = await this.rootFor(utility.scope)
      if (!root) continue
      const group = groups.get(root) ?? { root, members: [] }
      group.members.push(utility)
      groups.set(root, group)
    }
    // A root the caller says is no longer installed still has to be swept, so it
    // joins the pass with nothing expected in it.
    for (const scope of options.pruneScopes ?? []) {
      const root = await this.rootFor(scope)
      if (root && !groups.has(root)) groups.set(root, { root, members: [] })
    }

    for (const group of groups.values()) {
      try {
        const folders = await this.resolveFolders(group.root, group.members)
        await this.removeUnclaimedFolders(group.root, folders)
        for (const utility of group.members) {
          const folder = folders.get(utility.id)
          if (folder) await this.installInto(group.root, folder, utility)
        }
      } catch (error) {
        // One unreachable root (a project on a volume that is not mounted) must
        // not stop every other install from being kept in step.
        Logger.dev('Utility install root could not be reconciled:', error)
      }
    }

    await this.pruneThreadRoots(new Set(groups.keys())).catch((error) =>
      Logger.dev('Stale thread utility folders could not be pruned:', error)
    )
    await this.pruneProjectRoots(new Set(groups.keys())).catch((error) =>
      Logger.dev('Stale project utility folders could not be pruned:', error)
    )
  }

  /**
   * Folder each member owns in one root: the folder already carrying its id,
   * otherwise its preferred name when that name is free, otherwise the name plus
   * as much of the id as it takes to be unique.
   */
  private async resolveFolders(
    root: string,
    members: readonly UtilityDefinition[]
  ): Promise<Map<string, string>> {
    const existing = await readManifests(root)
    const folders = new Map<string, string>()
    const claimed = new Map<string, string>()
    for (const utility of members) {
      const owned = [...existing.entries()].find(([, manifest]) => manifest?.id === utility.id)
      const folder = owned?.[0] ?? freeFolderName(utility, existing, claimed)
      folders.set(utility.id, folder)
      claimed.set(folder, utility.id)
    }
    return folders
  }

  private async installInto(
    root: string,
    folder: string,
    utility: UtilityDefinition
  ): Promise<void> {
    const directory = join(root, folder)
    await this.removeUtilityFolders(root, utility.id, folder)
    await mkdir(directory, { recursive: true })
    await writeIfChanged(
      join(directory, UTILITY_INSTALL_MANIFEST),
      `${JSON.stringify(manifestFor(utility), null, 2)}\n`
    )
    if (utility.kind === 'skill') {
      await writeIfChanged(
        join(directory, SKILL_INSTALL_FILE),
        `${utility.config.instructions.trimEnd()}\n`
      )
      return
    }
    await writeIfChanged(
      join(directory, MCP_INSTALL_FILE),
      `${JSON.stringify(mcpConnection(utility), null, 2)}\n`
    )
  }

  /** Remove the folders this utility owns, except the one that must stay. */
  private async removeUtilityFolders(
    root: string,
    utilityId: string,
    keep?: string
  ): Promise<void> {
    for (const [folder, manifest] of await readManifests(root)) {
      if (manifest?.id !== utilityId || folder === keep) continue
      await rm(join(root, folder), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Remove folders in this root no member owns. A folder without this app's
   * manifest is left alone: the user may have put it there.
   */
  private async removeUnclaimedFolders(
    root: string,
    folders: ReadonlyMap<string, string>
  ): Promise<void> {
    const claimedIds = new Set(folders.values())
    for (const [folder, manifest] of await readManifests(root)) {
      if (!manifest) continue
      if (claimedIds.has(manifest.id) && folders.get(folder) === manifest.id) continue
      await rm(join(root, folder), { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Remove thread install roots no live thread-scoped utility points at. */
  private async pruneThreadRoots(visited: ReadonlySet<string>): Promise<void> {
    const root = join(this.storage.resolve(CONFIG_UTILITIES_DIRECTORY), THREAD_UTILITIES_DIRECTORY)
    for (const entry of await listDirectories(root)) {
      const directory = join(root, entry)
      if (visited.has(directory)) continue
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** Remove project install folders whose utility is no longer in the registry. */
  private async pruneProjectRoots(visited: ReadonlySet<string>): Promise<void> {
    const listProjectPaths = this.deps.listProjectPaths
    if (!listProjectPaths) return
    const projects = (await listProjectPaths().catch(() => [])) ?? []
    for (const project of projects) {
      const root = join(project.path, CIO_SCRATCH_DIRECTORY, PROJECT_UTILITIES_DIRECTORY)
      if (visited.has(root)) continue
      await this.removeUnclaimedFolders(root, new Map())
    }
  }
}

/** A folder name of this utility's own, never one another utility already holds. */
function freeFolderName(
  utility: UtilityDefinition,
  existing: ReadonlyMap<string, UtilityInstallManifest | null>,
  claimed: ReadonlyMap<string, string>
): string {
  const preferred = preferredFolderName(utility)
  const taken = (folder: string): boolean => {
    const holder = claimed.get(folder)
    if (holder !== undefined && holder !== utility.id) return true
    const manifest = existing.get(folder)
    return manifest !== undefined && manifest !== null && manifest.id !== utility.id
  }
  if (!taken(preferred)) return preferred
  for (const length of [8, 16]) {
    const candidate = `${preferred}--${utility.id.slice(0, length)}`
    if (!taken(candidate)) return candidate
  }
  return `${preferred}--${utility.id}`
}

/** Read every folder's manifest in one install root, keyed by folder name. */
async function readManifests(root: string): Promise<Map<string, UtilityInstallManifest | null>> {
  const manifests = new Map<string, UtilityInstallManifest | null>()
  for (const entry of await listDirectories(root)) {
    manifests.set(entry, await readManifest(join(root, entry, UTILITY_INSTALL_MANIFEST)))
  }
  return manifests
}

async function readManifest(path: string): Promise<UtilityInstallManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const manifest = parsed as Record<string, unknown>
    return typeof manifest['id'] === 'string' && typeof manifest['name'] === 'string'
      ? (manifest as unknown as UtilityInstallManifest)
      : null
  } catch {
    return null
  }
}

async function listDirectories(root: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

/** Write only when the content differs, so an unchanged install is not touched. */
async function writeIfChanged(path: string, content: string): Promise<void> {
  const current = await readFile(path, 'utf-8').catch(() => null)
  if (current === content) return
  await writeFile(path, content, 'utf-8')
}
