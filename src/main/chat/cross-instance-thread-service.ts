/**
 * Shared thread state another CodeInOven instance changed.
 *
 * Two instances share one config root, so they share the thread table and the
 * mirrored conversation in it, while each process only ever sees the writes it
 * makes itself. A window in the other instance therefore holds a row that has
 * since been renamed, pinned, read, archived or settled, and a transcript that
 * has since gained a prompt, an answer or an attachment, with nothing to tell it
 * so. The writer announces the threads it touched (see `instanceRegistry`), and
 * this service is what reacts: it re-reads those rows from the shared database
 * and pushes the corrected snapshots to this instance's renderers, and tells
 * them to re-read the transcripts of the threads whose messages changed.
 *
 * Nothing is inferred from timing and no thread data rides in the announcement
 * itself, so a missed batch costs freshness until the next one, never
 * correctness. Only the writer announces, and every push below is a local
 * fan-out, so two instances can never bounce an announcement back and forth.
 */

import type { Thread } from '../../lib/types'
import type { Database } from '../database/database'
import { ThreadRepo } from '../database/repositories/thread-repo'
import type { CrossInstanceThreadEvent } from '../system/instance-registry'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'
import {
  broadcastCrossInstanceThreadDeleted,
  broadcastCrossInstanceThreadUpdate,
  broadcastThreadMessagesChanged
} from './thread-events'

export interface CrossInstanceThreadServiceOptions {
  /** Persisted rows for thread ids, read off the main thread. */
  readThreads?: (ids: readonly string[]) => Promise<Thread[]>
  /** Hand one corrected row to this instance's renderers. */
  publishThread?: (thread: Thread) => void
  /** Tell this instance's renderers to re-read one thread's transcript. */
  publishMessages?: (projectId: string, threadId: string) => void
  /** Drop one thread from this instance's renderers. */
  publishDeleted?: (projectId: string, threadId: string) => void
  /**
   * Where announcements come from. A narrow port so the service can be driven by
   * a peer registry in a test instead of the process-wide one.
   */
  subscribeToChanges?: (listener: (event: CrossInstanceThreadEvent) => void) => () => void
}

export class CrossInstanceThreadService {
  private stopListening: (() => void) | null = null
  private readonly readThreads: (ids: readonly string[]) => Promise<Thread[]>
  private readonly publishThread: (thread: Thread) => void
  private readonly publishMessages: (projectId: string, threadId: string) => void
  private readonly publishDeleted: (projectId: string, threadId: string) => void
  private readonly subscribeToChanges: (
    listener: (event: CrossInstanceThreadEvent) => void
  ) => () => void

  constructor(
    private readonly db: Database,
    options: CrossInstanceThreadServiceOptions = {}
  ) {
    this.readThreads =
      options.readThreads ?? ((ids) => new ThreadRepo(this.db).listByIdsViaWorker(ids))
    this.publishThread = options.publishThread ?? broadcastCrossInstanceThreadUpdate
    this.publishMessages = options.publishMessages ?? broadcastThreadMessagesChanged
    this.publishDeleted =
      options.publishDeleted ??
      ((projectId, threadId) => broadcastCrossInstanceThreadDeleted({ projectId, id: threadId }))
    this.subscribeToChanges =
      options.subscribeToChanges ?? ((listener) => instanceRegistry.onThreadChanged(listener))
  }

  /** Start reacting to a sibling's shared-thread announcements. */
  start(): void {
    if (this.stopListening) return
    this.stopListening = this.subscribeToChanges((event) => void this.apply(event))
  }

  /** Stop reacting. */
  dispose(): void {
    this.stopListening?.()
    this.stopListening = null
  }

  /**
   * Apply one batch: deletions first, then the transcript notices, then the rows.
   *
   * Order matters for the surfaces that watch both: a window told to re-read a
   * transcript of a thread that is gone would re-read nothing, and a row that
   * arrives after its own deletion would resurrect it, so the deletion wins by
   * being sent before its row (a batch cannot carry both, but two batches can).
   */
  private async apply(event: CrossInstanceThreadEvent): Promise<void> {
    for (const change of event.deleted) {
      this.publishDeleted(change.projectId, change.threadId)
    }
    for (const change of event.messages) {
      this.publishMessages(change.projectId, change.threadId)
    }
    if (event.rows.length === 0) return
    try {
      const threads = await this.readThreads(event.rows.map((change) => change.threadId))
      for (const thread of threads) {
        this.publishThread(thread)
      }
    } catch (error) {
      // Advisory only: a renderer keeps what it was given, and the sibling's next
      // change to that thread re-reads the row.
      Logger.error('Cross-instance thread refresh failed (non-fatal):', error)
    }
  }
}
