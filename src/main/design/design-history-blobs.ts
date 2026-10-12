import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfigRoot } from '../../lib/utils'
import type { CheckpointBlobStore } from '../git/change-tracking-service'

/**
 * Where a design's history keeps the bytes of every revision.
 *
 * The checkpoint blob store is content-addressed the same way, but it is shared by
 * every turn checkpoint of a project and a maintenance pass prunes whatever no
 * checkpoint references. A design's revisions are not checkpoints, so they get their
 * own store instead of depending on a pruner that does not know about them: the
 * folder's own snapshots are what says which hashes are live, and nothing else
 * touches this directory.
 *
 * The store is per folder rather than per project because a blob is only ever read
 * back through the folder it belongs to, so a hash can mean one file in one design
 * and pruning one design can never reach into another's bytes.
 */

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid design history blob hash: ${value}`)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * The directory a folder's history blobs live in.
 *
 * The folder path is percent-encoded so a nested design (`pages/pricing`) or one
 * whose segments could collide (`a/b` against `a%2Fb`) never resolves to another
 * folder's store.
 */
export function designHistoryBlobDirectory(projectId: string, directory: string): string {
  return join(getConfigRoot(), 'projects', projectId, 'design-blobs', encodeURIComponent(directory))
}

export class DesignHistoryBlobStore implements CheckpointBlobStore {
  private readonly base: string

  constructor(projectId: string, directory: string) {
    this.base = designHistoryBlobDirectory(projectId, directory)
  }

  async put(hash: string, content: Uint8Array): Promise<void> {
    assertHash(hash)
    const path = join(this.base, hash)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
  }

  async get(hash: string): Promise<Uint8Array | null> {
    assertHash(hash)
    try {
      return await readFile(join(this.base, hash))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  /**
   * Remove every blob this folder's history no longer references.
   *
   * `referenced` is the union of the hashes held by the revisions that survived a
   * prune, so a hash shared by a kept revision is left alone. Bounded: a ceiling on
   * the entries read keeps a folder with an enormous blob history from holding the
   * caller while the rest is cleaned on a later pass.
   */
  async prune(referenced: ReadonlySet<string>, maxEntries = 5_000): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(this.base)
    } catch (error) {
      if (isMissing(error)) return 0
      throw error
    }
    let removed = 0
    for (const entry of entries) {
      if (removed >= maxEntries) break
      if (referenced.has(entry)) continue
      try {
        await unlink(join(this.base, entry))
        removed += 1
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    }
    return removed
  }
}
