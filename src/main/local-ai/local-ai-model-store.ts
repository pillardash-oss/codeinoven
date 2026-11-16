/**
 * The durable home for a local AI model, and the move that gets it there.
 *
 * A Hugging Face download lands in a cache, and a cache is the wrong place to
 * serve a model from: it is the engine's scratch area, `huggingface_hub` prunes
 * nothing, and a snapshot is a folder of symlinks into a blob store that a cleanup
 * is free to empty. So a finished download is moved here, into the app's own
 * `local-models` directory, and the saved row is rewritten to that path. From then
 * on the model is an ordinary folder or file the user owns: the server loads it
 * from there, the card measures it there, and removing it removes only our copy.
 *
 * The move copies file contents instead of renaming the snapshot directory: the
 * snapshot's entries are symlinks into `../../blobs`, and renaming the directory
 * would leave every weight pointing at a path that no longer means what it did.
 */
import { copyFile, lstat, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigRoot } from '../../lib/utils'

/** The folder under the app's config root that holds models the app owns. */
export function localModelsRoot(): string {
  return join(getConfigRoot(), 'local-models')
}

/** A repository name as one directory name, `owner--repo`. */
function repositoryFolderName(reference: string): string {
  const segments = reference
    .trim()
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length !== 2) return ''
  return segments.map((segment) => segment.replaceAll(/[^A-Za-z0-9._-]/gu, '-')).join('--')
}

/**
 * Copy one file or folder tree into `targetDirectory`, following symlinks.
 *
 * Symlinks are read through, because the source is a cache whose entries point at
 * blobs elsewhere: the copy has to be self-contained, so a link becomes the file it
 * names. Everything lands under a temporary name first and is renamed into place, so
 * an interrupted move never leaves a half-written model that the next start would
 * believe in.
 */
export async function moveModelInto(sourcePath: string, targetDirectory: string): Promise<void> {
  const info = await stat(sourcePath)
  if (info.isDirectory()) {
    await copyTree(sourcePath, targetDirectory)
    return
  }
  if (!info.isFile()) throw new Error('That path is not a model file or folder')
  const target = join(targetDirectory, sourcePath.split(/[\\/]/u).pop() ?? 'model')
  await mkdir(targetDirectory, { recursive: true })
  const temporary = `${target}.${randomUUID()}.partial`
  try {
    await copyFile(sourcePath, temporary)
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function copyTree(sourceDirectory: string, targetDirectory: string): Promise<void> {
  const temporary = `${targetDirectory}.${randomUUID()}.partial`
  await mkdir(temporary, { recursive: true })
  try {
    await copyEntries(sourceDirectory, temporary)
    await mkdir(join(targetDirectory, '..'), { recursive: true })
    // Replace a previous copy of the same model rather than merging into it: a
    // half-old folder with a missing shard is worse than a fresh one.
    await rm(targetDirectory, { recursive: true, force: true })
    await rename(temporary, targetDirectory)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
}

async function copyEntries(sourceDirectory: string, targetDirectory: string): Promise<void> {
  const entries = await readdir(sourceDirectory)
  for (const entry of entries) {
    const from = join(sourceDirectory, entry)
    const to = join(targetDirectory, entry)
    const info = await lstat(from)
    const follows = info.isSymbolicLink() ? await stat(from) : info
    if (follows.isDirectory()) {
      await mkdir(to, { recursive: true })
      await copyEntries(from, to)
      continue
    }
    if (!follows.isFile()) continue
    await copyFile(from, to)
  }
}

/** Bytes a file or folder holds, following the symlinks a cache tree is made of. */
async function treeBytes(path: string): Promise<number> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(path)
  } catch {
    return 0
  }
  if (info.isFile()) return info.size
  if (!info.isDirectory()) return 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) total += await treeBytes(join(path, entry))
  return total
}

/**
 * Remove what a finished move copied, so the cache does not keep a second copy.
 *
 * Only a byte-for-byte match is removed: the weights are the one thing that must
 * never be half-deleted, so a copy that does not measure up leaves the source where
 * it is and the row keeps working.
 *
 * A Hugging Face snapshot is a folder of links into a repository's blob store, so
 * removing the snapshot alone frees nothing. Once the last snapshot under a
 * repository is gone, the repository folder goes with it, blobs included.
 */
async function removeMovedSource(sourcePath: string, targetPath: string): Promise<void> {
  const [source, target] = await Promise.all([treeBytes(sourcePath), treeBytes(targetPath)])
  if (source <= 0 || source !== target) return
  await rm(sourcePath, { recursive: true, force: true })
  const snapshotDirectory = dirname(sourcePath)
  if (basename(snapshotDirectory) !== 'snapshots') return
  let remaining: string[]
  try {
    remaining = await readdir(snapshotDirectory)
  } catch {
    return
  }
  if (remaining.length > 0) return
  const repositoryDirectory = dirname(snapshotDirectory)
  if (!basename(repositoryDirectory).startsWith('models--')) return
  await rm(repositoryDirectory, { recursive: true, force: true })
}

/**
 * Move a finished download into the app's model directory and answer where it now
 * lives.
 *
 * A GGUF model is one file, so the answer is the file's new path; an MLX model is a
 * folder of weights, so the answer is the folder. Null means the move could not
 * happen, and the row then keeps whatever path it already had instead of being
 * pointed at something that is not there.
 */
export async function adoptLocalAiModel(
  reference: string,
  sourcePath: string,
  /** Root to move into; the app's own models folder unless a test says otherwise. */
  root: string = localModelsRoot()
): Promise<string | null> {
  const source = sourcePath.trim()
  if (source.length === 0 || !isAbsolute(source)) return null
  const folder = repositoryFolderName(reference)
  if (folder.length === 0) return null
  const target = join(root, folder)
  try {
    const info = await stat(source)
    if (!info.isFile() && !info.isDirectory()) return null
    await moveModelInto(source, target)
    const adopted = info.isDirectory()
      ? target
      : join(target, source.split(/[\\/]/u).pop() ?? 'model')
    await removeMovedSource(source, adopted)
    return adopted
  } catch {
    return null
  }
}

/** Whether a path is inside the app's own model directory. */
export function isManagedModelPath(path: string): boolean {
  const root = resolve(localModelsRoot())
  const target = resolve(path.trim())
  return target === root || target.startsWith(`${root}${sep}`)
}

/**
 * Delete a model the app owns.
 *
 * Only paths inside `local-models` are accepted: a model the user picked from their
 * own disk is their file, and a cache path belongs to an engine that is free to
 * prune it. False means nothing was removed.
 */
export async function deleteLocalAiModel(path: string): Promise<boolean> {
  const target = path.trim()
  if (target.length === 0 || !isManagedModelPath(target)) return false
  try {
    await rm(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}
