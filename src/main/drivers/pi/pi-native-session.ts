import { createReadStream, existsSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '../../../lib/types'
import { parseRecord } from '../../../lib/agent-interactions'
import { Logger } from '../../system/logger'
import type { PersistentCliSession } from '../persistent-cli-driver'
import { buildAssistantMessage, serializeContent } from './pi-stream-fold'
import { messageTimestamp, record, stringValue } from './pi-values'

/** Pi's native session JSONL transcripts: discovery, prefill, parsing, reconciliation. */

function piAgentDir(): string {
  const envDir = process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    if (envDir === '~') return homedir()
    if (envDir.startsWith('~/')) return join(homedir(), envDir.slice(2))
    return envDir
  }
  return join(homedir(), '.pi', 'agent')
}

/** Mirror pi's own session-dir encoding (`--<cwd>--` under the agent dir). */
function nativePiSessionDir(projectPath: string): string {
  const safePath = `--${projectPath.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
  return join(piAgentDir(), 'sessions', safePath)
}

/**
 * Find a native pi session transcript by session id. Pi names files
 * `<timestamp>_<sessionId>.jsonl`; the newest match wins.
 */
async function findNativePiSessionFile(
  projectPath: string,
  sessionId: string
): Promise<string | null> {
  const dir = nativePiSessionDir(projectPath)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  const matches = entries.filter((name) => name.endsWith(`_${sessionId}.jsonl`)).sort()
  const latest = matches.at(-1)
  return latest ? join(dir, latest) : null
}

/**
 * Wait for pi to flush a sub-agent's native session transcript. pi creates
 * the .jsonl in one synchronous write when the session's first assistant
 * message completes, so watching the directory for its creation is the
 * reliable signal   no polling. Resolves the file path, or null on timeout
 * or if the directory cannot be watched.
 */
async function waitForNativePiSessionFile(
  projectPath: string,
  sessionId: string,
  timeoutMs = 10_000
): Promise<string | null> {
  const dir = nativePiSessionDir(projectPath)
  const suffix = `_${sessionId}.jsonl`
  const deadline = Date.now() + timeoutMs
  // A sub-agent can spawn before the primary session's first flush has
  // created the project's native session directory, so `watch(dir)` throws.
  // Wait for the directory to appear within the same budget instead of
  // failing immediately with "CLI session is unavailable".
  while (!existsSync(dir)) {
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  let watcher: FSWatcher
  try {
    watcher = watch(dir)
  } catch {
    return null
  }
  return new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => finish(null), Math.max(deadline - Date.now(), 0))
    const finish = (file: string | null): void => {
      clearTimeout(timer)
      watcher.close()
      resolve(file)
    }
    watcher.on('error', () => finish(null))
    watcher.on('rename', (filename) => {
      if (typeof filename === 'string' && filename.endsWith(suffix)) {
        finish(join(dir, filename))
      }
    })
    // The transcript may have been flushed between the caller's existence
    // check and the watcher attaching   no rename event would fire for it.
    // Attach the watcher first, then re-check so neither window is missed.
    void findNativePiSessionFile(projectPath, sessionId).then((file) => {
      if (file) finish(file)
    })
  })
}

function nativeUserMessageText(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .map((block) =>
      record(block)?.['type'] === 'text' ? stringValue(record(block)?.['text']) : undefined
    )
    .filter((text): text is string => Boolean(text))
  return parts.join('\n')
}

/**
 * Serialize CodeInOven mirror messages into native pi session JSONL entries  
 * the inverse of `parseNativePiSession` at conversation granularity. Only text
 * content is carried over: tool calls and reasoning blocks are execution
 * detail the resumed model does not need, and fabricating toolResult entries
 * would desynchronize pi's own accounting. Returns an empty array when the
 * mirror carries no conversational text.
 */
function prefillTranscriptEntries(
  projectPath: string,
  messages: readonly AgentMessage[]
): string[] {
  const lines: string[] = [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      cwd: projectPath
    })
  ]
  let parentId: string | null = null
  let wroteMessage = false
  for (const message of messages) {
    // Presentation-mode user prompts carry their visible content in a
    // `user-presentation` part (action + body) instead of a text part. Skip
    // them here and the seeded native transcript loses every user message,
    // leaving only assistant output and tool trace for the resumed model.
    const text = message.parts
      .flatMap((part) => {
        if (part.type === 'text') return [part.text]
        if (part.type === 'user-presentation') {
          return [[part.presentation.action, part.presentation.body].filter(Boolean).join('\n')]
        }
        return []
      })
      .join('\n')
      .trim()
    if (!text) continue
    const id = randomUUID()
    lines.push(
      JSON.stringify({
        type: 'message',
        id,
        parentId,
        timestamp: new Date(message.createdAt ?? Date.now()).toISOString(),
        message: { role: message.role, content: [{ type: 'text', text }] }
      })
    )
    parentId = id
    wroteMessage = true
  }
  return wroteMessage ? lines : []
}

/**
 * Parse a native pi session JSONL transcript into CodeInOven messages.
 * Used for sub-agent worker threads, which run as in-process pi sessions
 * persisted by pi's own SessionManager rather than mirrored through RPC.
 */
async function parseNativePiSession(file: string, sessionId: string): Promise<AgentMessage[]> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  const messages: AgentMessage[] = []
  const entryTimes = new Map<string, number>()
  let turnIndex = 0
  let userIndex = 0
  for await (const line of lines) {
    if (!line.trim()) continue
    let entry: Record<string, unknown> | undefined
    try {
      entry = record(JSON.parse(line)) ?? undefined
    } catch {
      continue
    }
    if (!entry) continue
    if (entry['type'] === 'compaction') {
      const summary = stringValue(entry['summary'])
      const firstKeptEntryId = stringValue(entry['firstKeptEntryId'])
      if (summary?.trim()) {
        const id = `pi-${sessionId}-compaction-${turnIndex}`
        messages.push({
          id,
          role: 'assistant',
          origin: 'compaction',
          visibility: 'working_trace',
          createdAt: Date.parse(String(entry['timestamp'])) || Date.now(),
          parts: [
            {
              type: 'compaction',
              id: `${id}:compaction`,
              messageID: id,
              auto: true,
              summary,
              firstKeptEntryId,
              firstKeptCreatedAt: firstKeptEntryId ? entryTimes.get(firstKeptEntryId) : undefined
            }
          ]
        })
      }
      continue
    }
    if (entry['type'] !== 'message') continue
    const nativeMessage = record(entry['message'])
    if (typeof entry['id'] === 'string' && nativeMessage) {
      entryTimes.set(entry['id'], messageTimestamp(nativeMessage))
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
    const message = record(entry['message'])
    if (!message) continue
    const role = stringValue(message['role'])
    if (role === 'assistant') {
      turnIndex += 1
      const built = buildAssistantMessage(message, sessionId, {
        assistantMessageId: null,
        turnIndex
      })
      if (built?.messages?.length) messages.push(...built.messages)
      continue
    }
    if (role === 'user') {
      const text = nativeUserMessageText(message)
      if (!text) continue
      userIndex += 1
      const messageId = `pi-${sessionId}-user-${userIndex}`
      messages.push({
        id: messageId,
        role: 'user',
        parts: [{ type: 'text', id: `${messageId}:text`, messageID: messageId, text }],
        createdAt: messageTimestamp(message)
      })
      continue
    }
    if (role === 'toolResult') {
      const callId = stringValue(message['toolCallId'])
      if (!callId) continue
      const output = serializeContent(message['content'])
      const failed = message['isError'] === true
      // Complete the most recent tool part carrying this call id.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const candidate = messages[index]
        if (!candidate) continue
        const partIndex = candidate.parts.findIndex(
          (part) => part.type === 'tool' && part.callID === callId
        )
        const part = partIndex === -1 ? undefined : candidate.parts[partIndex]
        if (!part || part.type !== 'tool') continue
        candidate.parts[partIndex] = {
          ...part,
          state: {
            ...part.state,
            status: failed ? 'error' : 'completed',
            ...(output ? { output } : {}),
            ...(failed && output ? { error: output } : {})
          }
        }
        break
      }
    }
  }
  return messages
}

export {
  nativePiSessionDir,
  findNativePiSessionFile,
  waitForNativePiSessionFile,
  prefillTranscriptEntries,
  parseNativePiSession
}

/** Returns null when no native transcript exists so the caller rethrows. */
export async function loadNativeSubagentMessages(
  projectPath: string,
  sessionId: string,
  waitForFlush: boolean
): Promise<AgentMessage[] | null> {
  // The chat engine captures a sub-agent's transcript the moment the spawn
  // tool reports its childSessionId   but pi defers a new session's first
  // disk write until its first assistant message completes
  // (SessionManager._persist), so the .jsonl can appear seconds later.
  // React to the file's creation instead of polling: watch the session
  // directory and parse as soon as pi flushes it. The engine's capture race
  // timeout is 15 s, so a ~10 s wait stays inside it. When the caller
  // guarantees the child is no longer live (`waitForFlush: false`) a
  // missing file is final   watching would only burn seconds waiting for
  // a transcript that can never appear, on every tab reopen.
  const existing = await findNativePiSessionFile(projectPath, sessionId)
  const file =
    existing ?? (waitForFlush ? await waitForNativePiSessionFile(projectPath, sessionId) : null)
  if (!file) return null
  // pi writes the flushed file synchronously before closing it, but keep a
  // short stabilization window in case the create event lands mid-flush.
  const populatedBy = Date.now() + 2_000
  for (;;) {
    try {
      const messages = await parseNativePiSession(file, sessionId)
      if (messages.length > 0) return messages
    } catch (error) {
      if (Date.now() >= populatedBy) {
        Logger.dev('Pi native sub-agent transcript parse failed:', error)
        return null
      }
    }
    if (Date.now() >= populatedBy) return null
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

/**
 * Post-turn compaction reconciliation (see `finishTurn`).
 *
 * Compaction reporting normally rides the live RPC event stream
 * (`compaction_end` / `auto_compaction_end` records). That stream is lost
 * when pi exits during or right after a compaction, when the engine
 * finalizes a settled session through the synthetic-idle watchdog, or when
 * pi compacts between turns. In all three cases the compaction is already
 * written durably to pi's own session JSONL, so this pass reads that
 * transcript once and:
 *
 * 1. Backfills `firstKeptCreatedAt` onto mirrored compaction parts whose
 *    boundary timestamp lookup raced the session-id sync, so recap and fork
 *    boundaries never silently discard the compaction.
 * 2. Mirrors compaction entries that never arrived as events, using the
 *    same message shape as `parseNativePiSession`, deduplicated against
 *    what was already reported by retained-boundary id or summary text.
 */
export async function reconcileNativeCompactions(
  session: PersistentCliSession,
  projectPath: string | undefined,
  merge: (messages: AgentMessage[]) => void
): Promise<void> {
  const nativeSessionId = session.nativeSessionId
  if (!projectPath || !nativeSessionId) return
  const file = await findNativePiSessionFile(projectPath, nativeSessionId)
  if (!file) return
  const compactionEntries: {
    summary: string
    firstKeptEntryId?: string
    createdAt: number
  }[] = []
  const entryTimes = new Map<string, number>()
  const input = createReadStream(file)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const entry = parseRecord(line)
      if (!entry) continue
      if (entry['type'] === 'compaction') {
        const summary = stringValue(entry['summary'])
        if (summary?.trim()) {
          compactionEntries.push({
            summary,
            firstKeptEntryId: stringValue(entry['firstKeptEntryId']),
            createdAt: Date.parse(String(entry['timestamp'])) || Date.now()
          })
        }
        continue
      }
      if (entry['type'] === 'message') {
        const id = entry['id']
        const nativeMessage = parseRecord(entry['message'])
        if (typeof id === 'string' && nativeMessage) {
          entryTimes.set(id, messageTimestamp(nativeMessage))
        }
      }
    }
  } finally {
    lines.close()
    input.destroy()
  }
  let patched = false
  for (const message of session.messages) {
    for (const part of message.parts) {
      if (part.type !== 'compaction') continue
      if (part.firstKeptCreatedAt !== undefined || !part.firstKeptEntryId) continue
      const retainedAt = entryTimes.get(part.firstKeptEntryId)
      if (retainedAt !== undefined) {
        part.firstKeptCreatedAt = retainedAt
        patched = true
      }
    }
  }
  const recovered: AgentMessage[] = []
  for (const entry of compactionEntries) {
    const alreadyMirrored = session.messages.some((message) =>
      message.parts.some(
        (part) =>
          part.type === 'compaction' &&
          ((entry.firstKeptEntryId && part.firstKeptEntryId === entry.firstKeptEntryId) ||
            (part.summary?.trim() ?? '') === entry.summary)
      )
    )
    if (alreadyMirrored) continue
    const retainedAt = entry.firstKeptEntryId ? entryTimes.get(entry.firstKeptEntryId) : undefined
    const createdAt = retainedAt ?? entry.createdAt
    const id = `pi-${session.id}-compaction-native-${createdAt}`
    recovered.push({
      id,
      role: 'assistant',
      origin: 'compaction',
      visibility: 'working_trace',
      createdAt,
      parts: [
        {
          type: 'compaction',
          id: `${id}:compaction`,
          messageID: id,
          auto: true,
          summary: entry.summary,
          ...(entry.firstKeptEntryId && retainedAt !== undefined
            ? {
                firstKeptEntryId: entry.firstKeptEntryId,
                firstKeptCreatedAt: retainedAt
              }
            : {})
        }
      ]
    })
  }
  if (recovered.length === 0 && !patched) return
  if (recovered.length > 0) merge(recovered)
  Logger.dev(
    `Pi compaction reconciliation: ${recovered.length} recovered, boundary backfill ${patched ? 'applied' : 'not needed'}`
  )
}
