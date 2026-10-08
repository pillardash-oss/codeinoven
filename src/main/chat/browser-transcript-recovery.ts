import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentMessage, AgentPart, Thread } from '../../lib/types'
import { appendPartDelta, mergeStreamedPart } from '../../lib/agent-part-merge'
import type { StorageEngine } from '../storage/storage-engine'
import { turnStreamPath } from './turn-stream'
import type { TurnStreamEvent } from './turn-stream'
import { capPersistedPart } from './bounded-tool-output'

interface RecoverySink {
  read(messageId: string): Promise<AgentMessage | undefined>
  write(message: AgentMessage): Promise<void>
}

/** Recover the browser's own stream without starting a provider or reading its
 * storage. Fold one contiguous message at a time and yield between small reads.
 * Existing provider records remain authoritative; only stream-recovered rows
 * are refined when a later segment revisits the same message. */
export async function recoverBrowserTranscript(
  storage: Pick<StorageEngine, 'rawSize' | 'readRawChunk'>,
  thread: Thread,
  sink: RecoverySink
): Promise<void> {
  const path = turnStreamPath(thread.projectId, thread.id)
  const size = await storage.rawSize(path)
  if (!size) return
  let offset = 0
  let carry = Buffer.alloc(0)
  let message: AgentMessage | undefined
  let parts = new Map<string, AgentPart>()
  let skip = false
  const recoveredIds = new Set<string>()
  const flush = async (): Promise<void> => {
    if (!message || skip || parts.size === 0) return
    await sink.write({ ...message, parts: [...parts.values()] })
    recoveredIds.add(message.id)
  }
  const absorb = async (line: string): Promise<void> => {
    let event: TurnStreamEvent
    try {
      event = JSON.parse(line) as TurnStreamEvent
    } catch {
      return
    }
    if (
      (event.kind !== 'part.updated' && event.kind !== 'part.delta') ||
      typeof event.messageId !== 'string' ||
      !event.messageId ||
      typeof event.ts !== 'number' ||
      !Number.isFinite(event.ts)
    )
      return
    if (message?.id !== event.messageId) {
      await flush()
      const existing = await sink.read(event.messageId)
      // Stream rows deliberately carry harness provenance. A provider snapshot
      // or a real user message must never be replaced with inferred history.
      skip = !!existing && (existing.role !== 'assistant' || existing.origin !== 'harness')
      message = existing ?? {
        id: event.messageId,
        role: 'assistant',
        origin: 'harness',
        visibility: 'conversation',
        harnessId: thread.sessionHarnessId ?? thread.settings?.harnessId,
        createdAt: event.ts,
        parts: []
      }
      // A fresh scan must not seed deltas from the previous scan's final text.
      // Only a message revisited within this scan needs its earlier segment.
      parts = new Map(
        (recoveredIds.has(message.id) ? message.parts : []).map((part) => [part.id, part])
      )
    }
    if (skip) return
    if (event.kind === 'part.updated') {
      if (!event.part || typeof event.part.id !== 'string') return
      const part = capPersistedPart(event.part)
      const previous = parts.get(part.id)
      parts.set(part.id, previous ? mergeStreamedPart(previous, part) : part)
    } else {
      const previous = parts.get(event.partId)
      if (previous && typeof event.delta === 'string') {
        parts.set(
          event.partId,
          capPersistedPart(appendPartDelta(previous, event.field, event.delta))
        )
      }
    }
  }
  while (offset < size) {
    const chunk = await storage.readRawChunk(path, offset, Math.min(256 * 1024, size - offset))
    if (!chunk || chunk.bytesRead === 0) break
    offset = chunk.nextByte
    const bytes = carry.length ? Buffer.concat([carry, chunk.buffer]) : chunk.buffer
    const end = bytes.lastIndexOf(0x0a)
    if (end < 0) {
      carry = Buffer.from(bytes)
      continue
    }
    carry = Buffer.from(bytes.subarray(end + 1))
    let count = 0
    for (const line of bytes
      .subarray(0, end + 1)
      .toString('utf8')
      .split('\n')) {
      if (line.trim()) await absorb(line)
      if (++count % 32 === 0) await yieldToEventLoop()
    }
    await yieldToEventLoop()
  }
  // A partial final line was interrupted while being written; never invent it.
  await flush()
}
