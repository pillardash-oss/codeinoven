import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
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
  constructor(private readonly projectId: string) {}

  async put(hash: string, content: Uint8Array): Promise<void> {
    assertHash(hash)
    const path = join(getConfigRoot(), `projects/${this.projectId}/blobs/${hash}`)
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
      return await readFile(join(getConfigRoot(), `projects/${this.projectId}/blobs/${hash}`))
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async revision(): Promise<string> {
    try {
      return await readFile(
        join(getConfigRoot(), `projects/${this.projectId}/blob-revision`),
        'utf-8'
      )
    } catch (error) {
      if (isMissing(error)) return ''
      throw error
    }
  }
}
