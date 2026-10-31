import { Logger } from '../../system/logger'
import type { AgentEvent } from '../../../lib/types'
import {
  compactTurnStreamEvents,
  foldTurnStreamDetailed,
  type FoldedTurnStream
} from '../turn-stream'
import type { TurnStreamEvent } from '../turn-stream'
import type { TurnStreamCacheEntry } from './chat-engine-types'
import { deliverBroadcast, turnStreamPath } from './chat-engine-pure'
import { ChatEngine } from '../chat-engine'

/** ChatEngine turns-stream: one concern, moved verbatim from the composition root. */
export class ChatEngineTurnsStream {
  constructor(private readonly host: ChatEngine) {}

  /** The most recently used parse cache for a stream log, trimmed to its bound. */
  turnStreamEntry(streamPath: string): TurnStreamCacheEntry {
    const entry = this.host.state.turnStreamCache.get(streamPath) ?? {
      consumedBytes: 0,
      events: [],
      latestTurnId: '',
      foldKey: null,
      folded: null,
      completedKey: null,
      completed: null,
      retainFromTs: null
    }
    this.host.state.turnStreamCache.delete(streamPath)
    this.host.state.turnStreamCache.set(streamPath, entry)
    while (this.host.state.turnStreamCache.size > ChatEngine.TURN_STREAM_CACHE_LIMIT) {
      const oldest = this.host.state.turnStreamCache.keys().next().value
      if (oldest === undefined || oldest === streamPath) break
      this.host.state.turnStreamCache.delete(oldest)
    }
    return entry
  }

  /** Read and fold a thread's whole durable turn stream, with activity times. */
  async readWholeTurnStream(
    projectId: string,
    threadId: string,
    turnStartTs: number | undefined
  ): Promise<FoldedTurnStream> {
    const empty: FoldedTurnStream = { parts: [], lastActivityTs: new Map() }
    const streamPath = turnStreamPath(projectId, threadId)
    const size = await this.host.storage.rawSize(streamPath)
    if (size === null || size === 0) return empty
    const hydrated = await this.host.units['thread-lifecycle'].readTurnStreamOffThread(
      streamPath,
      0,
      size,
      turnStartTs
    )
    if (hydrated.events.length === 0) return empty
    return foldTurnStreamDetailed(hydrated.events, hydrated.latestTurnId || undefined, turnStartTs)
  }

  /**
   * Trim a thread's durable stream log to the events the fold needs.
   *
   * The in-memory compaction is what bounds the parse cache, and the events it
   * keeps are exactly what a fresh load would read, so writing them back is a
   * faithful file trim rather than a second, divergent notion of what matters.
   * The rewrite runs on the file's append queue: an append queued before it is
   * already on disk and folded in, and one queued after it lands after the trim.
   * A load that advanced the cache while the rewrite waited aborts it, so the
   * newer events can never be dropped.
   */
  async compactTurnStream(
    streamPath: string,
    fromByte: number,
    retained: TurnStreamEvent[],
    turnStartTs: number | undefined
  ): Promise<void> {
    if (this.host.state.compactingTurnStreams.has(streamPath)) return
    this.host.state.compactingTurnStreams.add(streamPath)
    try {
      await this.host.storage.rewriteRawFrom(streamPath, fromByte, (appended) => {
        const entry = this.host.state.turnStreamCache.get(streamPath)
        // A load advanced the cache while this rewrite was queued, so its newer
        // events are not in `retained` and rewriting would drop them. The next
        // load, which starts from the current offset, compacts instead.
        if (!entry || entry.consumedBytes !== fromByte) return null
        const events = retained.slice()
        for (const line of appended.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed) as TurnStreamEvent
            if (parsed.kind === 'part.updated' || parsed.kind === 'part.delta') events.push(parsed)
          } catch {
            // A malformed line is dropped exactly as the loader drops it.
          }
        }
        const compacted = compactTurnStreamEvents(events, turnStartTs)
        const text = compacted.map((event) => `${JSON.stringify(event)}\n`).join('')
        const nextBytes = Buffer.byteLength(text)
        const currentBytes = fromByte + Buffer.byteLength(appended)
        // A rewrite only pays off when it materially shrinks the file: a turn that
        // is one huge segment, or a log that is already just the current turn,
        // would otherwise be rewritten on every load for no gain. Compare bytes,
        // not JS string length, so multi-byte text is never misjudged as smaller.
        if (nextBytes === 0 || nextBytes * 2 > currentBytes) return null
        entry.events = compacted
        entry.consumedBytes = nextBytes
        entry.foldKey = null
        entry.folded = null
        Logger.dev('Trimmed turn stream log', { currentBytes, nextBytes })
        return text
      })
    } catch (error) {
      Logger.dev('Turn stream compaction failed:', error)
    } finally {
      this.host.state.compactingTurnStreams.delete(streamPath)
    }
  }

  queueStreamBroadcast(
    event: Extract<
      AgentEvent,
      {
        type: 'message.part.updated' | 'message.part.delta' | 'usage.updated' | 'session.status'
      }
    >
  ): void {
    if (event.type === 'message.part.updated') {
      const partPrefix = `${event.sessionId}:${event.part.messageID}:${event.part.id}`
      const key = `part:${partPrefix}`
      // Keep queued deltas and deliver the latest snapshot after them. Some
      // harnesses finish reasoning with a shorter or summary-only snapshot;
      // deleting the deltas here permanently cut text out of the renderer.
      // Reinsert an existing key so Map iteration keeps causal order.
      this.host.state.pendingStreamBroadcasts.delete(key)
      this.host.state.pendingStreamBroadcasts.set(key, event)
    } else if (event.type === 'message.part.delta') {
      const key = `delta:${event.sessionId}:${event.messageId}:${event.partId}:${event.field}`
      const pending = this.host.state.pendingStreamBroadcasts.get(key)
      this.host.state.pendingStreamBroadcasts.set(
        key,
        pending?.type === 'message.part.delta'
          ? { ...event, delta: `${pending.delta}${event.delta}` }
          : event
      )
    } else if (event.type === 'usage.updated') {
      this.host.state.pendingStreamBroadcasts.set(
        `usage:${event.sessionId}:${event.messageId}`,
        event
      )
    } else {
      this.host.state.pendingStreamBroadcasts.set(`status:${event.sessionId}`, event)
    }

    if (this.host.state.streamBroadcastTimer) return
    this.host.state.streamBroadcastTimer = setTimeout(() => {
      this.host.state.streamBroadcastTimer = null
      this.flushStreamBroadcasts()
    }, ChatEngine.STREAM_BROADCAST_INTERVAL_MS)
  }

  flushStreamBroadcasts(): void {
    if (this.host.state.streamBroadcastTimer) {
      clearTimeout(this.host.state.streamBroadcastTimer)
      this.host.state.streamBroadcastTimer = null
    }
    if (this.host.state.pendingStreamBroadcasts.size === 0) return
    const events = [...this.host.state.pendingStreamBroadcasts.values()]
    this.host.state.pendingStreamBroadcasts.clear()
    for (const event of events) deliverBroadcast(event)
  }
}
