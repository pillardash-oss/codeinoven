import { createReadStream, existsSync, watch } from 'node:fs'
import type { FSWatcher } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AgentMessage } from '../../../lib/types'
import { parseRecord } from '../../../lib/agent-interactions'
import { Logger } from '../../system/logger'
import type { PersistentCliSession } from '../persistent-cli-driver'
import { buildAssistantMessage, serializeContent } from './pi-stream-fold'
import { mapPiCost } from './pi-usage'
import { messageTimestamp, record, stringValue } from './pi-values'

/** Pi's native session JSONL transcripts: discovery, prefill, parsing, reconciliation. */

/**
 * Resolve the pi agent directory a session's transcripts live under.
 *
 * `agentDirectory` is the account's own container when the driver serves a
 * managed account, and undefined for the harness-global account. Pi always
 * writes a session inside the agent directory its own process was launched
 * with, so a reader that resolves this from the app's process environment
 * alone looks in the wrong directory for every managed account, and each
 * resume for that account silently cold-starts on a brand new session.
 */
function piAgentDir(agentDirectory?: string): string {
  const envDir = agentDirectory?.trim() || process.env.PI_CODING_AGENT_DIR
  if (envDir) {
    if (envDir === '~') return homedir()
    if (envDir.startsWith('~/')) return join(homedir(), envDir.slice(2))
    return envDir
  }
  return join(homedir(), '.pi', 'agent')
}

/** Mirror pi's own session-dir encoding (`--<cwd>--` under the agent dir). */
function nativePiSessionDir(projectPath: string, agentDirectory?: string): string {
  const safePath = `--${projectPath.replace(/^[/\\]/u, '').replace(/[/\\:]/gu, '-')}--`
  return join(piAgentDir(agentDirectory), 'sessions', safePath)
}

/**
 * Where pi's own session transcripts for one project are read from.
 *
 * A pi process writes its transcript beside itself, so a reader has to look
 * where that process wrote it: this machine's disk for a local session, and the
 * machine the session runs on for an Oven turn. Discovery, resume, cold-session
 * reads and deletion are therefore written once against this seam, and a
 * caller that runs pi somewhere else supplies its own source instead.
 */
export interface PiNativeTranscriptSource {
  /** The absolute path a pi running beside these files would open. */
  resolve(projectPath: string, fileName: string): string
  /** File names in the project's transcript directory, or null when it is absent. */
  list(projectPath: string): Promise<string[] | null>
  /** File text, or null when it is gone. */
  read(projectPath: string, fileName: string): Promise<string | null>
  /**
   * Write one whole transcript file, creating the directory pi would have
   * created for it.
   */
  write(projectPath: string, fileName: string, content: string): Promise<void>
  /** Resolve the newest file whose name ends with this suffix, waiting up to `timeoutMs` for it to appear. */
  waitFor(projectPath: string, suffix: string, timeoutMs: number): Promise<string | null>
  remove(projectPath: string, fileName: string): Promise<void>
  /**
   * Whether this source is where that project's transcripts live at all.
   *
   * The turn lifecycle reaches two transcript reads by project path alone (see
   * `reconcileNativeCompactions` and `findNativePiSessionFile`), so a driver
   * whose sessions run on another machine installs its source for the whole app
   * (see `installRemotePiNativeTranscriptSource`). This is what keeps a project
   * that runs here on this machine's own files instead of being read over that
   * source's machine, where it has no transcripts at all.
   */
  holds(projectPath: string): boolean
}

/**
 * The transcripts pi writes on this machine, under the agent directory its own
 * process was launched with.
 */
function localPiNativeTranscriptSource(agentDirectory?: string): PiNativeTranscriptSource {
  const directoryOf = (projectPath: string): string =>
    nativePiSessionDir(projectPath, agentDirectory)
  const source: PiNativeTranscriptSource = {
    resolve: (projectPath, fileName) => join(directoryOf(projectPath), fileName),
    list: async (projectPath) => {
      try {
        return await readdir(directoryOf(projectPath))
      } catch {
        // A project pi has never written to has no session directory at all,
        // which is "no transcripts", not a failure.
        return null
      }
    },
    read: async (projectPath, fileName) => {
      try {
        return await readFile(join(directoryOf(projectPath), fileName), 'utf8')
      } catch {
        return null
      }
    },
    write: async (projectPath, fileName, content) => {
      // pi creates the project's session directory on its first flush, so a
      // seeded transcript has to create it exactly the same way.
      const directory = directoryOf(projectPath)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, fileName), content, 'utf8')
    },
    waitFor: (projectPath, suffix, timeoutMs) =>
      watchForNativePiTranscript(source, directoryOf(projectPath), projectPath, suffix, timeoutMs),
    remove: async (projectPath, fileName) => {
      await rm(join(directoryOf(projectPath), fileName), { force: true })
    },
    // Every project's transcripts are here: this is the source of last resort.
    holds: () => true
  }
  return source
}

/**
 * The source for sessions whose pi process runs on another machine.
 *
 * `reconcileNativeCompactions` and `findNativePiSessionFile` are reached from the
 * turn lifecycle by project path alone, so a driver that starts pi somewhere
 * else installs its source here once and every transcript read for a project
 * that machine holds goes there instead of this computer's disk. A driver whose
 * sessions run here installs nothing and leaves the local source in place. One
 * app run has one Oven runtime (`installOvenPiRuntime`), so at most one such
 * source exists.
 */
let remotePiNativeTranscripts: PiNativeTranscriptSource | null = null

/** Install the source for projects whose pi runs elsewhere, or clear it with null. */
export function installRemotePiNativeTranscriptSource(
  source: PiNativeTranscriptSource | null
): void {
  remotePiNativeTranscripts = source
}

/**
 * Where one project's transcripts are read from.
 *
 * A project bound to the installed remote source is read there; every other
 * project is read here, so a machine that also runs pi sessions on an Oven keeps
 * its local threads on its own files.
 */
function piNativeTranscriptSourceFor(
  projectPath: string,
  agentDirectory?: string
): PiNativeTranscriptSource {
  const remote = remotePiNativeTranscripts
  if (remote?.holds(projectPath)) return remote
  return localPiNativeTranscriptSource(agentDirectory)
}

/**
 * The members a source must implement to be usable by every reader above.
 *
 * A source can arrive from another layer (the Oven runtime hands one to the
 * driver that starts pi there), so they are checked at the boundary instead of
 * being trusted on a structural cast.
 */
const MANDATORY_TRANSCRIPT_SOURCE_MEMBERS = [
  'resolve',
  'list',
  'read',
  'write',
  'waitFor',
  'remove',
  'holds'
] as const

/**
 * Whether a value is a usable transcript source.
 *
 * See `MANDATORY_TRANSCRIPT_SOURCE_MEMBERS`.
 */
function isPiNativeTranscriptSource(value: unknown): value is PiNativeTranscriptSource {
  const candidate = record(value)
  return MANDATORY_TRANSCRIPT_SOURCE_MEMBERS.every(
    (member) => typeof candidate?.[member] === 'function'
  )
}

/**
 * Find a native pi session transcript's file name by session id. Pi names files
 * `<timestamp>_<sessionId>.jsonl`; the newest match wins.
 */
async function findNativePiTranscriptName(
  source: PiNativeTranscriptSource,
  projectPath: string,
  sessionId: string
): Promise<string | null> {
  return newestTranscriptName(source, projectPath, `_${sessionId}.jsonl`)
}

/** The newest file name in one transcript directory whose name ends with a suffix. */
async function newestTranscriptName(
  source: PiNativeTranscriptSource,
  projectPath: string,
  suffix: string
): Promise<string | null> {
  const entries = await source.list(projectPath)
  if (!entries) return null
  const matches = entries.filter((name) => name.endsWith(suffix)).sort()
  return matches.at(-1) ?? null
}

/** The absolute path of a native pi transcript, read wherever it lives. */
async function findNativePiSessionFile(
  projectPath: string,
  sessionId: string,
  agentDirectory?: string
): Promise<string | null> {
  const source = piNativeTranscriptSourceFor(projectPath, agentDirectory)
  const name = await findNativePiTranscriptName(source, projectPath, sessionId)
  return name ? source.resolve(projectPath, name) : null
}

/** The newest file in one transcript directory whose name ends with a suffix. */
async function newestTranscriptMatching(
  source: PiNativeTranscriptSource,
  projectPath: string,
  suffix: string
): Promise<string | null> {
  const name = await newestTranscriptName(source, projectPath, suffix)
  return name ? source.resolve(projectPath, name) : null
}

/**
 * Wait for pi to flush a sub-agent's native session transcript. pi creates the
 * .jsonl in one synchronous write when the session's first assistant message
 * completes, so watching the directory for its creation is the reliable signal,
 * never a poll. Resolves the file path, or null on timeout or if the directory
 * cannot be watched.
 */
async function watchForNativePiTranscript(
  source: PiNativeTranscriptSource,
  directory: string,
  projectPath: string,
  suffix: string,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  // A sub-agent can spawn before the primary session's first flush has
  // created the project's native session directory, so `watch(dir)` throws.
  // Wait for the directory to appear within the same budget instead of
  // failing immediately with "CLI session is unavailable".
  while (!existsSync(directory)) {
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  let watcher: FSWatcher
  try {
    watcher = watch(directory)
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
    // Any event in the directory can be the flush. The name a watcher reports
    // is not dependable (some runtimes hand back the event type instead of the
    // file), and re-listing answers exactly the question the caller asked, so
    // every event re-checks for the newest match.
    const check = (): void => {
      void newestTranscriptMatching(source, projectPath, suffix).then((file) => {
        if (file) finish(file)
      })
    }
    watcher.on('error', () => finish(null))
    watcher.on('rename', check)
    watcher.on('change', check)
    // The transcript may have been flushed between the caller's existence
    // check and the watcher attaching, so no event would fire for it. Attach the
    // watcher first, then re-check so neither window is missed.
    check()
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
 * Parse the text of a native pi session JSONL transcript into CodeInOven
 * messages.
 *
 * Used for sub-agent worker threads, which run as in-process pi sessions
 * persisted by pi's own SessionManager rather than mirrored through RPC, and
 * for every transcript that does not live on this machine. The parsing is split
 * from the reading so a transcript fetched from an Oven yields exactly the
 * messages the same content yields here.
 */
async function parseNativePiTranscriptText(
  text: string,
  sessionId: string
): Promise<AgentMessage[]> {
  return parseNativePiTranscriptLines(linesOfText(text), sessionId)
}

/** Parse a native pi session JSONL transcript that lives on this machine. */
async function parseNativePiSession(file: string, sessionId: string): Promise<AgentMessage[]> {
  const input = createReadStream(file)
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    return await parseNativePiTranscriptLines(lines, sessionId)
  } finally {
    lines.close()
    input.destroy()
  }
}

/** The lines of a transcript that is already in memory. */
async function* linesOfText(text: string): AsyncGenerator<string> {
  for (const line of text.split(/\r?\n/u)) yield line
}

async function parseNativePiTranscriptLines(
  lines: AsyncIterable<string>,
  sessionId: string
): Promise<AgentMessage[]> {
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
        // pi folds a codemode call's nested and classifier usage onto this
        // result, so a restored transcript keeps that spend on the part.
        const cost = mapPiCost(message['usage'])
        candidate.parts[partIndex] = {
          ...part,
          state: {
            ...part.state,
            status: failed ? 'error' : 'completed',
            ...(output ? { output } : {}),
            ...(failed && output ? { error: output } : {}),
            ...(cost === undefined ? {} : { cost })
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
  localPiNativeTranscriptSource,
  piNativeTranscriptSourceFor,
  isPiNativeTranscriptSource,
  findNativePiTranscriptName,
  findNativePiSessionFile,
  prefillTranscriptEntries,
  parseNativePiSession,
  parseNativePiTranscriptText
}

/**
 * A delegated child session's transcript, read wherever that child's pi process
 * writes it.
 *
 * Returns null when no native transcript exists so the caller rethrows.
 */
export async function loadNativeSubagentMessages(
  projectPath: string,
  sessionId: string,
  options: {
    waitForFlush: boolean
    agentDirectory?: string
    /** The machine the child's pi runs on; this computer's disk when absent. */
    source?: PiNativeTranscriptSource
  }
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
  const source = options.source ?? localPiNativeTranscriptSource(options.agentDirectory)
  const existing = await findNativePiTranscriptName(source, projectPath, sessionId)
  const file =
    existing !== null
      ? source.resolve(projectPath, existing)
      : options.waitForFlush
        ? await source.waitFor(projectPath, `_${sessionId}.jsonl`, 10_000)
        : null
  if (!file) return null
  // pi writes the flushed file synchronously before closing it, but keep a
  // short stabilization window in case the create event lands mid-flush.
  const name = basename(file)
  const populatedBy = Date.now() + 2_000
  for (;;) {
    try {
      const text = await source.read(projectPath, name)
      if (text !== null) {
        const messages = await parseNativePiTranscriptText(text, sessionId)
        if (messages.length > 0) return messages
      }
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
  merge: (messages: AgentMessage[]) => void,
  agentDirectory?: string
): Promise<void> {
  const nativeSessionId = session.nativeSessionId
  if (!projectPath || !nativeSessionId) return
  const source = piNativeTranscriptSourceFor(projectPath, agentDirectory)
  const name = await findNativePiTranscriptName(source, projectPath, nativeSessionId)
  if (!name) return
  const text = await source.read(projectPath, name)
  if (text === null) return
  const compactionEntries: {
    summary: string
    firstKeptEntryId?: string
    createdAt: number
  }[] = []
  const entryTimes = new Map<string, number>()
  for (const line of text.split(/\r?\n/u)) {
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
