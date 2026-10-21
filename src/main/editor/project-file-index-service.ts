/// <reference types="electron-vite/node" />
import { createWorkQueue } from '../../lib/bounded-work'
import createIndexWorker from './project-file-index-worker.ts?nodeWorker'
import type { Worker } from 'node:worker_threads'
import type { ProjectFileEntry } from '../../lib/types'

export type IndexRequest =
  | {
      kind: 'search'
      projectId: string
      root: string
      query: string
      category: 'all' | 'rules'
      projectName?: string
    }
  | { kind: 'prewarm'; projectId: string; root: string }
  | { kind: 'invalidate' | 'dispose'; projectId: string }
export interface IndexResponse {
  id: number
  entries?: ProjectFileEntry[]
  error?: string
}

/** The index, watchers, Git parsing and ranking all live in one lazy worker.
 * Only bounded search results cross back to the Electron main process. */
export class ProjectFileIndexService {
  private readonly runIndexWork = createWorkQueue(1, 64)
  private worker?: Worker
  private sequence = 0
  private readonly keys = new Set<string>()
  private readonly pending = new Map<
    number,
    {
      resolve: (entries: ProjectFileEntry[]) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  search(
    projectId: string,
    root: string,
    query: string,
    category: 'all' | 'rules',
    projectName?: string
  ): Promise<ProjectFileEntry[]> {
    this.keys.add(projectId)
    return this.request({ kind: 'search', projectId, root, query, category, projectName })
  }

  async prewarm(projectId: string, root: string): Promise<void> {
    this.keys.add(projectId)
    await this.request({ kind: 'prewarm', projectId, root }).catch(() => undefined)
  }

  invalidate(projectId: string): void {
    if (this.worker) void this.request({ kind: 'invalidate', projectId }).catch(() => undefined)
  }

  indexKeys(): Iterable<string> {
    return this.keys.values()
  }

  dispose(projectId: string): void {
    this.keys.delete(projectId)
    if (!this.worker) return
    if (this.keys.size === 0) this.stop(this.worker, new Error('Project file index disposed'))
    else void this.request({ kind: 'dispose', projectId }).catch(() => undefined)
  }

  private stop(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    void worker.terminate()
  }

  private request(request: IndexRequest): Promise<ProjectFileEntry[]> {
    // Control messages must still invalidate an index while a build is awaiting I/O.
    if (request.kind === 'invalidate' || request.kind === 'dispose') return this.dispatch(request)
    return this.runIndexWork(() => {
      if (
        this.keys.size === 0 ||
        ((request.kind === 'search' || request.kind === 'prewarm') &&
          !this.keys.has(request.projectId))
      )
        return Promise.resolve([])
      // Start the watchdog when dispatched, not while waiting for another index.
      return this.dispatch(request)
    })
  }

  private dispatch(request: IndexRequest): Promise<ProjectFileEntry[]> {
    if (this.pending.size >= 64) return Promise.reject(new Error('Project file search is busy'))
    return new Promise((resolve, reject) => {
      let worker = this.worker
      if (!worker) {
        worker = createIndexWorker({ resourceLimits: { maxOldGenerationSizeMb: 256 } })
        this.worker = worker
        const current = worker
        worker.on('message', (response: IndexResponse) => {
          if (this.worker !== current) return
          const pending = this.pending.get(response.id)
          if (!pending) return
          this.pending.delete(response.id)
          clearTimeout(pending.timer)
          if (response.error) pending.reject(new Error(response.error))
          else pending.resolve(response.entries ?? [])
        })
        worker.on('error', (error: unknown) =>
          this.stop(current, error instanceof Error ? error : new Error(String(error)))
        )
        worker.on('exit', () => this.stop(current, new Error('Project file index worker exited')))
        worker.unref()
      }
      const id = ++this.sequence
      const current = worker
      const timer = setTimeout(
        () => this.stop(current, new Error('Project file search timed out')),
        10_000
      )
      this.pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ id, request })
      } catch (error) {
        this.stop(worker, error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
