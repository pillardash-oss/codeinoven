import { randomUUID } from 'node:crypto'
import type { VideoJob } from '../../lib/video/studio'
import { appServiceRegistry } from '../system/app-service-registry'

export interface VideoJobContext {
  signal: AbortSignal
  update: (progress: number, stage: string) => void
}
/**
 * What a job's signal is aborted with when its hard deadline passes.
 *
 * The distinction matters downstream: an aborted signal means the user
 * cancelled, unless the reason carries this type, in which case the work ran out
 * of time and the panel must report a failure rather than credit the user with a
 * cancellation they never made.
 */
class VideoJobDeadline extends Error {}
/** One expensive video job for the whole app; keep only 32 small terminal records. */
export class VideoJobs {
  private readonly jobs = new Map<string, { record: VideoJob; controller: AbortController }>()
  start(
    projectId: string,
    threadId: string,
    operation: string,
    run: (context: VideoJobContext) => Promise<{ files: string[]; result?: unknown }>
  ): VideoJob {
    if ([...this.jobs.values()].some((job) => job.record.state === 'running'))
      throw new Error(
        'Another video job is running. Wait for it to finish or cancel it in Video controls.'
      )
    while (this.jobs.size >= 32) this.jobs.delete(this.jobs.keys().next().value ?? '')
    const record: VideoJob = {
      id: randomUUID(),
      projectId,
      threadId,
      operation,
      state: 'running',
      stage: 'Starting',
      progress: 0,
      files: []
    }
    const controller = new AbortController()
    this.jobs.set(record.id, { record, controller })
    const serviceId = appServiceRegistry.register({
      kind: 'worker',
      name: `Video: ${operation}`,
      scope: 'thread',
      projectId,
      threadId,
      stop: () => {
        controller.abort()
      }
    })
    const deadline = setTimeout(
      () => controller.abort(new VideoJobDeadline('Video job exceeded 30 minutes')),
      30 * 60 * 1000
    )
    void Promise.resolve()
      .then(() =>
        run({
          signal: controller.signal,
          update: (progress, stage) => {
            record.progress = Math.max(0, Math.min(1, progress))
            record.stage = stage
          }
        })
      )
      .then((result) => {
        controller.signal.throwIfAborted()
        Object.assign(record, result, { state: 'completed', progress: 1, stage: 'Completed' })
      })
      .catch((error: unknown) => {
        const expired = controller.signal.reason instanceof VideoJobDeadline
        record.state = controller.signal.aborted && !expired ? 'cancelled' : 'failed'
        record.stage = record.state === 'cancelled' ? 'Cancelled' : 'Failed'
        record.error = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        clearTimeout(deadline)
        appServiceRegistry.unregister(serviceId)
      })
    return { ...record }
  }
  list(projectId: string, threadId: string): VideoJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.record.projectId === projectId && job.record.threadId === threadId)
      .map((job) => ({ ...job.record, files: [...job.record.files] }))
  }
  cancel(projectId: string, threadId: string, id: string): void {
    const job = this.jobs.get(id)
    if (!job || job.record.projectId !== projectId || job.record.threadId !== threadId)
      throw new Error('Video job does not belong to this thread')
    job.controller.abort()
  }
  dispose(): void {
    for (const job of this.jobs.values()) job.controller.abort()
  }
}
