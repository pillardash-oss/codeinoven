import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getConfigRoot } from '../../../lib/utils'
import type { CheckpointBlobStore } from '../../git/change-tracking-service'

function assertHash(value: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid checkpoint blob hash: ${value}`)
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

export class StorageCheckpointBlobStore implements CheckpointBlobStore {
  /** Created on the first put and reused afterwards: a snapshot stores one blob
   *  per changed file, and remaking the same directory a few thousand times was
   *  most of the cost of the first snapshot a project ever takes. */
  private directoryReady: Promise<void> | null = null

  constructor(private readonly projectId: string) {}

  async put(hash: string, content: Uint8Array): Promise<void> {
    assertHash(hash)
    const path = join(this.directoryPath(), hash)
    try {
      await this.write(path, content)
    } catch (error) {
      if (!isMissing(error)) throw error
      // External maintenance removed the directory we had already prepared;
      // rebuild it once rather than reporting a blob nobody can read back.
      this.directoryReady = null
      await this.write(path, content)
    }
  }

  async get(hash: string): Promise<Uint8Array | null> {
    assertHash(hash)
    try {
      return await readFile(join(this.directoryPath(), hash))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async revision(): Promise<string> {
    try {
      return await readFile(join(this.directoryPath(), '../blob-revision'), 'utf-8')
    } catch (error) {
      if (isMissing(error)) return ''
      throw error
    }
  }

  private directoryPath(): string {
    return join(getConfigRoot(), `projects/${this.projectId}/blobs`)
  }

  private async write(path: string, content: Uint8Array): Promise<void> {
    this.directoryReady ??= mkdir(this.directoryPath(), { recursive: true }).then(
      () => undefined,
      (error: unknown) => {
        this.directoryReady = null
        throw error
      }
    )
    await this.directoryReady
    try {
      await writeFile(path, content, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
  }
}
