/**
 * Where a downloaded model actually landed, once it finished downloading.
 *
 * A row saved from a Hugging Face tag is a tag until the server has fetched it,
 * and after that the same weights sit in a folder nobody has to look up again. This
 * module answers that folder, so the page can write it into the row: the next start
 * loads the local folder instead of asking the hub about a repository it already
 * has. LLM weights are multi-gigabyte, so a row that re-downloads because the app
 * never learned the path is a real cost, not a cosmetic one.
 *
 * Each engine answers differently, so each is asked the question it can answer:
 * llama.cpp reports the resolved path of the model it loaded on `/props`, which is
 * right whatever cache directory the user configured, while `mlx_lm.server` says
 * nothing about it and the Hugging Face cache layout is read instead.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { LocalAiModelLocation, LocalAiRuntimeId } from '../../lib/llama-cpp'

const PROPS_TIMEOUT_MS = 2_500
/** Snapshots hold a handful of files; this only bounds a hand-edited cache. */
const MAX_SNAPSHOT_FILES = 2_000

/**
 * The cache directories a Hugging Face download can land in, in the precedence
 * `huggingface_hub` itself applies. The server is launched with the environment the
 * app inherited, so these are the directories it would have written to.
 */
function huggingFaceCacheRoots(): string[] {
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

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * Bytes a snapshot occupies. A snapshot is a folder of links into the cache's own
 * blob store, and `stat` follows them, so the answer is the size of the weights the
 * user is actually storing.
 */
async function snapshotBytes(directory: string): Promise<number> {
  let total = 0
  let seen = 0
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (++seen > MAX_SNAPSHOT_FILES) break
    const path = join(directory, entry)
    try {
      const info = await stat(path)
      total += info.isDirectory() ? await snapshotBytes(path) : info.size
    } catch {
      // A snapshot link whose blob is gone contributes nothing.
    }
  }
  return total
}

/** A snapshot is complete when its config and at least one weights file are there. */
async function isCompleteSnapshot(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, 'config.json'))
  } catch {
    return false
  }
  try {
    const entries = await readdir(directory)
    return entries.some((entry) => /\.(?:safetensors|npz)$/iu.test(entry))
  } catch {
    return false
  }
}

/** The commit a repository's `main` ref points at, empty when it names none. */
async function readMainRef(repositoryDirectory: string): Promise<string> {
  try {
    return (await readFile(join(repositoryDirectory, 'refs', 'main'), 'utf8')).trim()
  } catch {
    return ''
  }
}

/**
 * The MLX snapshot a repository was downloaded to, or null when it is not cached.
 *
 * The ref is preferred because that is the snapshot the server would load, and the
 * newest complete snapshot answers for a cache written by an interrupted run.
 */
async function resolveMlxSnapshot(reference: string): Promise<LocalAiModelLocation | null> {
  const repository = reference.trim()
  const separator = repository.indexOf('/')
  if (separator < 1 || separator === repository.length - 1) return null
  const folder = `models--${repository.slice(0, separator)}--${repository.slice(separator + 1)}`
  for (const root of huggingFaceCacheRoots()) {
    const repositoryDirectory = join(root, folder)
    const snapshotsDirectory = join(repositoryDirectory, 'snapshots')
    let snapshots: string[]
    try {
      snapshots = await readdir(snapshotsDirectory)
    } catch {
      continue
    }
    const main = await readMainRef(repositoryDirectory)
    const ordered = main && snapshots.includes(main) ? [main, ...snapshots] : snapshots
    for (const snapshot of ordered) {
      const directory = join(snapshotsDirectory, snapshot)
      if (!(await isCompleteSnapshot(directory))) continue
      return { path: directory, bytes: await snapshotBytes(directory) }
    }
  }
  return null
}

/**
 * The model path llama.cpp reports for the server on this address.
 *
 * `/props` states the path it loaded, so a `-hf` row answers with the cache file
 * even when the user moved the cache with `LLAMA_CACHE`.
 */
async function resolveLlamaCppModel(baseUrl: string): Promise<LocalAiModelLocation | null> {
  let response: Response
  try {
    response = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) })
  } catch {
    return null
  }
  if (!response.ok) return null
  let path: string
  try {
    const body: unknown = await response.json()
    const value = (body as { model_path?: unknown }).model_path
    path = typeof value === 'string' ? value.trim() : ''
  } catch {
    return null
  }
  if (path.length === 0 || path.length > 4_096) return null
  if (!path.startsWith('/')) return null
  return { path, bytes: await fileSize(path) }
}

/** Where the model a running server downloaded is stored on this machine. */
export async function resolveModelLocation(input: {
  baseUrl: string
  runtime: LocalAiRuntimeId
  /** The repository the row was saved with, which is what a cache is looked up by. */
  reference: string
}): Promise<LocalAiModelLocation | null> {
  // The caller only asks for a row saved from a Hugging Face tag, so the path a
  // running server reports is the file that tag was fetched to.
  return input.runtime === 'mlx'
    ? resolveMlxSnapshot(input.reference)
    : resolveLlamaCppModel(input.baseUrl)
}
