/**
 * What a Hugging Face repository is, read before anything is fetched for it.
 *
 * The Local AI page lets a row name a repository instead of a path, and which of
 * the two engines can serve that repository is a fact the repository states about
 * itself: its `config.json` names the architecture and carries the MLX
 * quantisation block when the weights are MLX, and its file listing says whether a
 * GGUF conversion exists at all.
 *
 * Reading it first has two effects worth the two small reads: a row saved under the
 * wrong engine still runs, because the repository decides which engine launches it,
 * and a repository no engine here can load fails before a multi-gigabyte download
 * instead of after one.
 *
 * The cache answers first, so a repository already on disk costs no network call;
 * only a repository this machine has never seen asks the Hub, and a read that fails
 * leaves the row exactly as it was.
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  decideLocalAiRepoEngine,
  type LocalAiRepoDecision,
  type LocalAiRepoFacts
} from '../../lib/local-ai-repo'
import { findExecutable } from './local-ai-binary'

const PROPS_TIMEOUT_MS = 4_000
/** A repository listing is a few hundred names; this bounds a hand-edited cache. */
const MAX_REPO_FILES = 5_000

/** The cache directories a Hugging Face download can land in. */
function cacheRoots(): string[] {
  const roots: string[] = []
  const add = (candidate: string | undefined): void => {
    if (!candidate || !candidate.startsWith('/')) return
    const root = resolve(candidate)
    if (!roots.includes(root)) roots.push(root)
  }
  add(process.env['HF_HUB_CACHE'])
  add(process.env['HUGGINGFACE_HUB_CACHE'])
  add(process.env['HF_HOME'] ? join(process.env['HF_HOME'], 'hub') : undefined)
  add(
    process.env['XDG_CACHE_HOME']
      ? join(process.env['XDG_CACHE_HOME'], 'huggingface', 'hub')
      : undefined
  )
  add(join(homedir(), '.cache', 'huggingface', 'hub'))
  return roots
}

/** The cache folder a repository is stored under. */
function repositoryFolder(repository: string): string {
  const [owner, ...rest] = repository.split('/')
  return `models--${owner}--${rest.join('--')}`
}

/** Every file a cached snapshot holds, relative to the snapshot. */
async function cachedFiles(
  repository: string
): Promise<{ config: string; files: string[] } | null> {
  if (repository.split('/').length !== 2) return null
  const folder = repositoryFolder(repository)
  for (const root of cacheRoots()) {
    const snapshotsDirectory = join(root, folder, 'snapshots')
    let snapshots: string[]
    try {
      snapshots = await readdir(snapshotsDirectory)
    } catch {
      continue
    }
    // Newest first: an interrupted download can leave an older, incomplete one.
    const ordered = [...snapshots].sort().reverse()
    for (const snapshot of ordered) {
      const directory = join(snapshotsDirectory, snapshot)
      const files = await snapshotFiles(directory)
      if (files.length === 0) continue
      const config = files.includes('config.json')
        ? await readSnapshotFile(directory, 'config.json')
        : ''
      return { config, files }
    }
  }
  return null
}

async function snapshotFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= MAX_REPO_FILES) return
      const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(current, entry.name), relative)
      else if (entry.isFile()) files.push(relative)
    }
  }
  await walk(directory, '')
  return files
}

async function readSnapshotFile(directory: string, name: string): Promise<string> {
  try {
    return await readFile(join(directory, name), 'utf8')
  } catch {
    return ''
  }
}

/** A Hub read that gives up instead of holding a start open on a slow network. */
async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) })
    if (!response.ok) return ''
    return await response.text()
  } catch {
    return ''
  }
}

/** `config.json` for the repository, from the cache first and the Hub after. */
async function repoConfig(repository: string): Promise<string> {
  const cached = await cachedFiles(repository)
  if (cached?.config) return cached.config
  return await fetchText(`https://huggingface.co/${repository}/raw/main/config.json`)
}

/** The file names the repository publishes, from the cache first and the Hub after. */
async function repoFiles(repository: string): Promise<string[]> {
  const cached = await cachedFiles(repository)
  if (cached) return cached.files
  const body = await fetchText(`https://huggingface.co/api/models/${repository}?blobs=false`)
  if (body.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(body)
    const siblings = (parsed as { siblings?: unknown }).siblings
    if (!Array.isArray(siblings)) return []
    const files: string[] = []
    for (const sibling of siblings) {
      const name = (sibling as { rfilename?: unknown }).rfilename
      if (typeof name === 'string' && name.length > 0) files.push(name)
    }
    return files
  } catch {
    return []
  }
}

/** The architectures the mlx-lm install on this machine implements, lowercased. */
async function mlxArchitectures(): Promise<string[]> {
  const server = await findExecutable('mlx_lm.server')
  if (server.length === 0) return []
  // The server lives in the package's venv; its models folder is next to it.
  const roots = [join(server, '..', '..', 'lib'), join(server, '..', '..', '..', 'lib')]
  for (const root of roots) {
    const found = await architectureModules(root)
    if (found.length > 0) return found
  }
  return []
}

/** Walk one `lib` directory looking for the mlx-lm models package. */
async function architectureModules(libDirectory: string): Promise<string[]> {
  let versions: string[]
  try {
    versions = await readdir(libDirectory)
  } catch {
    return []
  }
  for (const version of versions) {
    const models = join(libDirectory, version, 'site-packages', 'mlx_lm', 'models')
    if (!existsSync(models)) continue
    try {
      const entries = await readdir(models)
      return entries
        .filter((entry) => entry.endsWith('.py') && !entry.startsWith('_'))
        .map((entry) => basename(entry, '.py').toLowerCase())
    } catch {
      return []
    }
  }
  return []
}

/** Whether a config block marks the repository's weights as MLX-quantised. */
function weightsFromConfig(config: string, files: readonly string[]): LocalAiRepoFacts['weights'] {
  const hasGguf = files.some((file) => file.toLowerCase().endsWith('.gguf'))
  if (hasGguf) return 'gguf'
  let parsed: unknown
  try {
    parsed = JSON.parse(config)
  } catch {
    parsed = null
  }
  if (parsed === null) return 'unknown'
  const quantization = (parsed as { quantization?: unknown }).quantization
  // MLX writes `quantization: { group_size, bits, mode }` into the config; a
  // Torch checkpoint keeps the same information under `quantization_config`.
  if (typeof quantization === 'object' && quantization !== null) return 'mlx'
  return 'torch'
}

/** The architecture name a `config.json` declares, empty when it declares none. */
function modelTypeFromConfig(config: string): string {
  try {
    const parsed: unknown = JSON.parse(config)
    const value = (parsed as { model_type?: unknown }).model_type
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

/**
 * Which engine of ours runs this repository, read from the repository itself.
 *
 * Never throws: an unreadable repository answers `unknown`, which leaves the row on
 * the engine it was saved with.
 */
export async function inspectLocalAiRepo(repository: string): Promise<LocalAiRepoDecision> {
  const reference = repository.trim()
  if (reference.length === 0 || reference.split('/').length !== 2) {
    return { kind: 'unknown', message: 'The repository name is not readable.' }
  }
  const [config, files, architectures] = await Promise.all([
    repoConfig(reference),
    repoFiles(reference),
    mlxArchitectures()
  ])
  return decideLocalAiRepoEngine({
    modelType: modelTypeFromConfig(config),
    weights: weightsFromConfig(config, files),
    mlxArchitectures: architectures
  })
}
