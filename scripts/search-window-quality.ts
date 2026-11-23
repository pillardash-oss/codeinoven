#!/usr/bin/env bun
/**
 * Measures how the window geometry of intent (semantic) thread search trades CPU
 * for recall, against the corpus on this machine, so a change to
 * `SEARCH_WINDOW_CHARS` or `SEARCH_MAX_WINDOWS_PER_THREAD` is decided by numbers
 * instead of a guess.
 *
 * What happens at index time in the app: a thread's conversation is cut into
 * several evenly spread windows of `SEARCH_WINDOW_CHARS` characters (window 0
 * opens the thread, the last one ends at its newest text, the rest are spread
 * between), and every window is embedded with a local GGUF embedding model
 * through llama.cpp. A query scores a thread by the cosine of its best-matching
 * window. A narrower window carries less unrelated conversation, so it matches
 * deep content better, but a thread needs more windows (more embeddings, more
 * CPU, a bigger index) to cover the same text.
 *
 * What this script measures: for each requested width it rebuilds those windows
 * for a deterministic sample of real threads, embeds them with a real local
 * llama-server, then asks which thread a 400-character passage taken from deep
 * inside a thread retrieves. It reports recall@1/5/10 and MRR per width, next to
 * the wall-clock embedding cost of that width. Two query forms are scored
 * separately: the raw passage, and the passage behind the model's search-query
 * prompt, because the app embeds queries with a prefix and documents without
 * one.
 *
 * The numbers make a window setting decidable because the corpus, the sample,
 * the query passages and the window math are fixed by `--seed` and the flags:
 * two widths measured in one run see the same threads and the same queries, so
 * the recall difference between them is the effect of the width and nothing
 * else. Quality alone is not the answer   a run also prints what each setting
 * costs in windows and seconds, which is the other half of the trade.
 *
 * `--strip fences` answers a second question with the same run: a window is
 * embedded verbatim by default, fences and diagram source included, which is what
 * production does. Listing both modes embeds the same window geometry twice, once
 * as it is and once with fenced blocks and <svg> markup removed, so the recall
 * difference is what carrying code in a window costs or earns. The geometry never
 * changes between the two, so only the embedded content differs.
 *
 * Honest caveat: the query passage is literal text taken from the thread it is
 * supposed to retrieve, so a window that overlaps it matches almost verbatim.
 * That makes absolute recall optimistic; it is comparable across settings, and
 * it is exactly what a window setting changes (how much deep content a window
 * actually covers). A window is tokenized and truncated to the launched
 * server's token budget before it is embedded, the same way the app embeds one,
 * so a setting whose windows are dense enough to be cut pays that loss here too.
 * The script never writes to the database; it opens it read-only.
 *
 * Usage: bun scripts/search-window-quality.ts --help
 * Example: bun scripts/search-window-quality.ts --threads 40 --queries 20 --widths 4096,2048,1024
 */

import { Database } from 'bun:sqlite'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Defaults and constants
// ---------------------------------------------------------------------------

const APP_DATA = join(homedir(), '.config', 'pillardash', 'codeinoven')
const DEFAULT_DB_PATH = join(APP_DATA, 'codeinoven.db')
const DEFAULT_SERVER_PATH = join(
  APP_DATA,
  'speech',
  'runtime',
  'llama-b11554',
  'llama-b11554',
  'llama-server'
)
const DEFAULT_MODEL_PATH = join(
  APP_DATA,
  'search',
  'models',
  'embeddinggemma-2-ud-q4-k-xl',
  'embeddinggemma-2-UD-Q4_K_XL.gguf'
)

/** Shorter threads cannot hold a deep query passage, so they are not measured. */
const MIN_THREAD_CHARS = 2000
/** Length of the passage lifted out of a thread to act as its query. */
const PASSAGE_CHARS = 400
/** Query prompt the embedding model expects in front of a search query. */
const QUERY_PREFIX = 'task: search result | query: '
/** Fixed port so the launch mirrors production and a stray server is obvious. */
const SERVER_PORT = 18997
const SERVER_HOST = '127.0.0.1'
const HEALTH_TIMEOUT_MS = 120_000
const REQUEST_TIMEOUT_MS = 300_000
const SHUTDOWN_GRACE_MS = 5000
const PROGRESS_EVERY = 24

/**
 * The production filter for searchable conversation: main-thread messages only
 * (no session sub-conversations) that the app shows as conversation.
 */
const CORPUS_SQL = `SELECT thread_id, role, parts, created_at FROM agent_messages
  WHERE session_id IS NULL AND visibility = 'conversation'
  ORDER BY thread_id, created_at`

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Whether a window is embedded verbatim or with its code and diagrams removed. */
type StripMode = 'raw' | 'fences'

interface Options {
  dbPath: string
  threadCount: number
  queryCount: number
  widths: number[]
  strip: StripMode[]
  maxWindows: number
  serverPath: string
  modelPath: string
  seed: number
  help: boolean
}

function usage(): string {
  return [
    'Usage: bun scripts/search-window-quality.ts [flags]',
    '',
    'Measures retrieval quality against embedding window width on the real corpus.',
    '',
    'Flags:',
    `  --db <path>        sqlite database to sample (read-only). Default: ${DEFAULT_DB_PATH}`,
    '  --threads <n>      threads to sample and index. Default: 120',
    '  --queries <n>      query passages to score per width. Default: 40',
    '  --widths <list>    comma separated window widths in characters. Default: 4096,2048',
    '  --strip <list>     how a window is embedded, comma separated:',
    '                       raw     the window verbatim, fences and diagram source included (production)',
    '                       fences  fenced blocks and <svg> removed before embedding, geometry unchanged',
    '                     Default: raw. Listing both measures the same windows with and without code.',
    '  --windows <n>      max windows per thread. Default: 6',
    `  --server <path>    llama-server binary. Default: ${DEFAULT_SERVER_PATH}`,
    `  --model <path>     GGUF embedding model. Default: ${DEFAULT_MODEL_PATH}`,
    '  --seed <n>         seed for the deterministic thread and passage sample. Default: 1',
    '  --help             print this text and exit',
    ''
  ].join('\n')
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    dbPath: DEFAULT_DB_PATH,
    threadCount: 120,
    queryCount: 40,
    widths: [4096, 2048],
    strip: ['raw'],
    maxWindows: 6,
    serverPath: DEFAULT_SERVER_PATH,
    modelPath: DEFAULT_MODEL_PATH,
    seed: 1,
    help: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const next = (): string => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) fail(`${flag} requires a value.`)
      index += 1
      return value
    }
    if (flag === '--help' || flag === '-h') options.help = true
    else if (flag === '--db') options.dbPath = next()
    else if (flag === '--threads') options.threadCount = positiveInt(next(), flag)
    else if (flag === '--queries') options.queryCount = positiveInt(next(), flag)
    else if (flag === '--widths') options.widths = parseWidths(next())
    else if (flag === '--strip') options.strip = parseStripModes(next())
    else if (flag === '--windows') options.maxWindows = positiveInt(next(), flag)
    else if (flag === '--server') options.serverPath = next()
    else if (flag === '--model') options.modelPath = next()
    else if (flag === '--seed') options.seed = nonNegativeInt(next(), flag)
    else fail(`unknown flag: ${flag}\n\n${usage()}`)
  }

  return options
}

function positiveInt(raw: string, flag: string): number {
  const value = nonNegativeInt(raw, flag)
  if (value < 1) fail(`${flag} must be at least 1.`)
  return value
}

function nonNegativeInt(raw: string, flag: string): number {
  if (!/^\d+$/u.test(raw)) fail(`${flag} expects a whole number, got "${raw}".`)
  return Number.parseInt(raw, 10)
}

function parseWidths(raw: string): number[] {
  const widths = raw.split(',').map((part) => {
    if (!/^\d+$/u.test(part.trim())) fail(`--widths expects whole numbers, got "${part}".`)
    const width = Number.parseInt(part.trim(), 10)
    if (width < 128 || width > 65536) fail(`--widths entries must be 128..65536, got ${width}.`)
    return width
  })
  if (widths.length === 0) fail('--widths needs at least one width.')
  return widths
}

function parseStripModes(raw: string): StripMode[] {
  const modes = raw.split(',').map((part) => part.trim())
  if (modes.length === 0) fail('--strip needs at least one mode.')
  for (const mode of modes) {
    if (mode !== 'raw' && mode !== 'fences')
      fail(`--strip expects "raw" or "fences", got "${mode}".`)
  }
  return modes as StripMode[]
}

function fail(message: string): never {
  writeErr(`error: ${message}\n`)
  process.exit(1)
}

function write(text: string): void {
  process.stdout.write(text)
}

function writeErr(text: string): void {
  process.stderr.write(text)
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

interface CorpusThread {
  id: string
  text: string
}

interface MessageRow {
  thread_id: string
  role: string
  parts: string
  created_at: number
}

/** One parsed entry of the `parts` JSON array. Only text entries matter here. */
interface MessagePart {
  type?: unknown
  text?: unknown
}

/**
 * Concatenate the `text` of every text part of one message. Reasoning, tool and
 * image parts are skipped: the production index only embeds conversation text.
 */
function extractText(partsJson: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(partsJson)
  } catch {
    return ''
  }
  if (!Array.isArray(parsed)) return ''
  const texts: string[] = []
  for (const entry of parsed as MessagePart[]) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.type !== 'text') continue
    if (typeof entry.text !== 'string') continue
    const text = entry.text.trim()
    if (text.length > 0) texts.push(text)
  }
  return texts.join('\n')
}

/**
 * Read the searchable corpus through the pipeline's own filter and fold each
 * thread's messages into one body of text in message order. Threads too short to
 * hold a deep passage are dropped.
 */
function loadCorpus(dbPath: string): { threads: CorpusThread[]; skippedShort: number } {
  if (!existsSync(dbPath)) fail(`database not found: ${dbPath}`)
  const db = new Database(dbPath, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout = 3000')
    const bodies = new Map<string, string[]>()
    const rows = db.query<MessageRow, []>(CORPUS_SQL).all()
    for (const row of rows) {
      const text = extractText(row.parts)
      if (text.length === 0) continue
      const body = bodies.get(row.thread_id)
      if (body) body.push(text)
      else bodies.set(row.thread_id, [text])
    }

    const threads: CorpusThread[] = []
    let skippedShort = 0
    for (const [id, messages] of bodies) {
      const text = messages.join('\n')
      if (text.length < MIN_THREAD_CHARS) {
        skippedShort += 1
        continue
      }
      threads.push({ id, text })
    }
    // The query orders by thread_id, but a Map does not promise it stays that
    // way; sorting makes the deterministic sample independent of insertion order.
    threads.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    return { threads, skippedShort }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Deterministic sampling
// ---------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG, so `--seed` reproduces a whole run. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates with the seeded PRNG, then take the head of the shuffled list. */
function sampleThreads(
  threads: readonly CorpusThread[],
  count: number,
  random: () => number
): CorpusThread[] {
  const shuffled = [...threads]
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = shuffled[index]
    shuffled[index] = shuffled[swap]
    shuffled[swap] = held
  }
  return shuffled.slice(0, Math.min(count, shuffled.length))
}

// ---------------------------------------------------------------------------
// Window geometry   copied from the production index, never imported from it
// ---------------------------------------------------------------------------

/**
 * Character offsets of each window of one thread. `count` matches the index's
 * `threadWindowCount`: as many windows as the thread needs, capped at
 * `maxWindows`. The offset formula matches `threadWindowOffset`: window 0 starts
 * at 0, the last ends at the end of the text, and the rest are an even spread.
 */
function windowOffsets(total: number, width: number, maxWindows: number): number[] {
  if (total <= 0 || width <= 0) return [0]
  const count = Math.min(maxWindows, Math.max(1, Math.ceil(total / width)))
  const offsets: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (count <= 1 || total <= width) {
      offsets.push(0)
      continue
    }
    offsets.push(Math.round((index * (total - width)) / (count - 1)))
  }
  return offsets
}

/** The actual text of one thread's windows at this width, in window order. */
function threadWindows(text: string, width: number, maxWindows: number): string[] {
  const total = text.length
  return windowOffsets(total, width, maxWindows).map((offset) =>
    text.slice(offset, Math.min(total, offset + width))
  )
}

// ---------------------------------------------------------------------------
// llama.cpp embedding server
// ---------------------------------------------------------------------------

let server: ChildProcess | null = null
let serverExited = false
const serverLog: string[] = []

function serverBaseUrl(): string {
  return `http://${SERVER_HOST}:${SERVER_PORT}`
}

function requireFiles(options: Options): void {
  if (!existsSync(options.serverPath)) fail(`llama-server binary not found: ${options.serverPath}`)
  if (!existsSync(options.modelPath)) fail(`embedding model not found: ${options.modelPath}`)
}

function launchServer(options: Options): ChildProcess {
  const args = [
    '--model',
    options.modelPath,
    '--host',
    SERVER_HOST,
    '--port',
    String(SERVER_PORT),
    '--ctx-size',
    '2048',
    '--batch-size',
    '2048',
    '--ubatch-size',
    '2048',
    '--gpu-layers',
    '0',
    '--prio',
    '-1',
    '--poll',
    '0',
    '--poll-batch',
    '0',
    '--threads',
    '1',
    '--threads-batch',
    '1',
    '--parallel',
    '1',
    '--embeddings'
  ]
  const child = spawn(options.serverPath, args, {
    stdio: ['ignore', 'ignore', 'pipe']
  })
  child.on('error', (error) => {
    writeErr(`error: could not start llama-server: ${error.message}\n`)
    process.exit(1)
  })
  child.on('exit', () => {
    serverExited = true
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      serverLog.push(line)
      if (serverLog.length > 40) serverLog.shift()
    }
  })
  return child
}

async function waitForHealth(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (serverExited) fail(`llama-server exited before it became healthy:\n${serverTail()}`)
    try {
      const response = await fetch(`${serverBaseUrl()}/health`, {
        signal: AbortSignal.timeout(2000)
      })
      if (response.ok) return
    } catch {
      // Not listening yet, or still loading the model.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  fail(`llama-server did not answer /health within ${HEALTH_TIMEOUT_MS / 1000}s:\n${serverTail()}`)
}

function serverTail(): string {
  return serverLog.slice(-12).join('\n')
}

async function stopServer(): Promise<void> {
  const child = server
  if (!child || serverExited) return
  child.kill('SIGTERM')
  const deadline = Date.now() + SHUTDOWN_GRACE_MS
  while (!serverExited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!serverExited) child.kill('SIGKILL')
}

/** L2-normalize in place and return the vector, so cosine is one dot product. */
function normalize(vector: Float32Array): Float32Array {
  let sum = 0
  for (const value of vector) sum += value * value
  const length = Math.sqrt(sum)
  if (length === 0) return vector
  for (let index = 0; index < vector.length; index += 1) vector[index] /= length
  return vector
}

async function embed(text: string): Promise<Float32Array> {
  return normalize(await embedTokens(await tokenize(text)))
}

/**
 * Token budget the launched server actually reports. A dense window (code, tables
 * and prose run together) can reach more characters per token than the model's
 * own tokenizer implies, so a window may exceed the physical batch. The app
 * tokenizes every window and truncates it to this budget before embedding, so
 * this script does the same instead of sending raw text and failing on a wide
 * setting.
 */
let tokenBudget = 0

async function readTokenBudget(): Promise<void> {
  const response = await fetch(`${serverBaseUrl()}/props`, {
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) fail(`llama-server refused /props (${response.status}).`)
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null) fail('llama-server returned an invalid /props.')
  const settings = 'default_generation_settings' in value ? value.default_generation_settings : null
  const context =
    typeof settings === 'object' && settings !== null && 'n_ctx' in settings ? settings.n_ctx : null
  if (typeof context !== 'number' || !Number.isInteger(context) || context < 2) {
    fail('llama-server did not report its context window through /props.')
  }
  tokenBudget = context
}

async function tokenize(text: string): Promise<number[]> {
  const response = await fetch(`${serverBaseUrl()}/tokenize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content: text, add_special: true }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500)
    fail(`tokenize request failed (${response.status}): ${body}`)
  }
  const value: unknown = await response.json()
  const tokens =
    typeof value === 'object' && value !== null && 'tokens' in value ? value.tokens : null
  if (!Array.isArray(tokens) || !tokens.every(isTokenId)) {
    fail('the embedding tokenizer returned invalid tokens.')
  }
  // Keep the physical batch honest: non-causal embeddings cannot split a
  // document, so the app truncates to one slot's worth of tokens. Same here.
  return tokens.slice(0, Math.max(1, tokenBudget - 1))
}

function isTokenId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

async function embedTokens(tokens: readonly number[]): Promise<Float32Array> {
  const response = await fetch(`${serverBaseUrl()}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: [tokens], model: 'local' }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500)
    fail(`embedding request failed (${response.status}): ${body}`)
  }
  const value: unknown = await response.json()
  const vector = firstEmbedding(value)
  if (!vector) fail('embedding response did not contain data[0].embedding')
  return vector
}

function firstEmbedding(value: unknown): Float32Array | null {
  if (!value || typeof value !== 'object' || !('data' in value)) return null
  const data = value.data
  if (!Array.isArray(data) || data.length === 0) return null
  const row: unknown = data[0]
  if (!row || typeof row !== 'object' || !('embedding' in row)) return null
  const embedding = row.embedding
  if (!Array.isArray(embedding) || embedding.length === 0) return null
  const vector = new Float32Array(embedding.length)
  for (let index = 0; index < embedding.length; index += 1) {
    const entry: unknown = embedding[index]
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null
    vector[index] = entry
  }
  return vector
}

/** Cosine of two already-normalized vectors, which is their dot product. */
function cosine(left: Float32Array, right: Float32Array): number {
  const length = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < length; index += 1) sum += left[index] * right[index]
  return sum
}

// ---------------------------------------------------------------------------
// Retrieval scoring
// ---------------------------------------------------------------------------

/** One sampled thread plus the vectors of its windows at the measured width. */
interface IndexedThread {
  id: string
  windows: Float32Array[]
}

interface QueryPassage {
  threadId: string
  passage: string
}

interface Metrics {
  recall1: number
  recall5: number
  recall10: number
  mrr: number
}

interface SettingResult {
  width: number
  /** How the windows were embedded: verbatim, or with code and diagrams removed. */
  strip: StripMode
  windows: number
  threadsWithWindows: number
  indexMs: number
  raw: Metrics
  prefixed: Metrics
}

/**
 * Rank every indexed thread by its best window cosine and return the thread ids
 * best-first. A thread's best window is what makes it answer a query, exactly as
 * the production index scores it.
 */
function rank(query: Float32Array, threads: readonly IndexedThread[]): string[] {
  const scored = threads.map((thread) => {
    let best = -Infinity
    for (const vector of thread.windows) best = Math.max(best, cosine(query, vector))
    return { id: thread.id, score: best }
  })
  scored.sort((left, right) => right.score - left.score)
  return scored.map((entry) => entry.id)
}

/**
 * A passage taken from deep inside a thread: it always starts after the head
 * window's opening text, so a head-only index cannot retrieve it by accident.
 * Passages come only from sampled threads with room for one.
 */
function buildQueries(
  threads: readonly CorpusThread[],
  count: number,
  random: () => number
): QueryPassage[] {
  const eligible = threads.filter((thread) => thread.text.length > MIN_THREAD_CHARS + PASSAGE_CHARS)
  if (eligible.length === 0)
    fail(
      `none of the sampled threads is longer than ${MIN_THREAD_CHARS + PASSAGE_CHARS} characters, so no deep passage can be taken. Sample more threads.`
    )
  const queries: QueryPassage[] = []
  for (let index = 0; index < count; index += 1) {
    const thread = eligible[Math.floor(random() * eligible.length)]
    const span = thread.text.length - PASSAGE_CHARS - MIN_THREAD_CHARS
    const start = MIN_THREAD_CHARS + Math.floor(random() * span)
    queries.push({ threadId: thread.id, passage: thread.text.slice(start, start + PASSAGE_CHARS) })
  }
  return queries
}

function scoreRetrieval(
  threads: readonly IndexedThread[],
  queries: readonly QueryPassage[],
  vectors: readonly Float32Array[]
): Metrics {
  let hits1 = 0
  let hits5 = 0
  let hits10 = 0
  let reciprocalRankSum = 0
  for (let index = 0; index < queries.length; index += 1) {
    const expected = queries[index].threadId
    const ranked = rank(vectors[index], threads)
    const position = ranked.indexOf(expected)
    const rankPosition = position < 0 ? Infinity : position + 1
    if (rankPosition <= 1) hits1 += 1
    if (rankPosition <= 5) hits5 += 1
    if (rankPosition <= 10) hits10 += 1
    if (Number.isFinite(rankPosition)) reciprocalRankSum += 1 / rankPosition
  }
  const total = queries.length
  return {
    recall1: hits1 / total,
    recall5: hits5 / total,
    recall10: hits10 / total,
    mrr: reciprocalRankSum / total
  }
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Remove the content a code-first window carries instead of conversation.
 *
 * Fenced blocks cover mermaid and every other diagram source, and `<svg>` covers
 * artifact markup that a presentation body carries inline. Nothing else is
 * touched: the point of the measurement is whether the dialogue around a block
 * retrieves better without the block's tokens competing for the window.
 */
function stripCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/gu, ' ').replace(/<svg\b[\s\S]*?<\/svg>/giu, ' ')
}

async function indexThreads(
  threads: readonly CorpusThread[],
  width: number,
  maxWindows: number,
  strip: StripMode
): Promise<{ indexed: IndexedThread[]; windows: number }> {
  const indexed: IndexedThread[] = []
  let windows = 0
  for (const thread of threads) {
    const texts = threadWindows(thread.text, width, maxWindows)
    const vectors: Float32Array[] = []
    for (const slice of texts) {
      const text = strip === 'fences' ? stripCodeBlocks(slice) : slice
      // A window that was nothing but code carries no conversation to embed, and
      // the production index has no vector for text it never had.
      if (text.trim().length === 0) continue
      vectors.push(await embed(text))
      windows += 1
      if (windows % PROGRESS_EVERY === 0) {
        writeErr(`  ${width}ch ${strip}: ${windows} windows embedded\r`)
      }
    }
    if (vectors.length > 0) indexed.push({ id: thread.id, windows: vectors })
  }
  writeErr(`  ${width}ch ${strip}: ${windows} windows embedded\n`)
  return { indexed, windows }
}

async function measureSetting(
  width: number,
  strip: StripMode,
  threads: readonly CorpusThread[],
  queries: readonly QueryPassage[],
  queryVectors: { raw: Float32Array[]; prefixed: Float32Array[] },
  options: Options
): Promise<SettingResult> {
  const indexStarted = performance.now()
  const { indexed, windows } = await indexThreads(threads, width, options.maxWindows, strip)
  const indexMs = performance.now() - indexStarted

  // Queries were embedded once for the run; these two passes only score.
  const raw = scoreRetrieval(indexed, queries, queryVectors.raw)
  const prefixed = scoreRetrieval(indexed, queries, queryVectors.prefixed)

  return { width, strip, windows, threadsWithWindows: indexed.length, indexMs, raw, prefixed }
}

async function embedQueries(queries: readonly QueryPassage[]): Promise<{
  raw: Float32Array[]
  prefixed: Float32Array[]
}> {
  const raw: Float32Array[] = []
  const prefixed: Float32Array[] = []
  for (let index = 0; index < queries.length; index += 1) {
    raw.push(await embed(queries[index].passage))
    prefixed.push(await embed(`${QUERY_PREFIX}${queries[index].passage}`))
    if ((index + 1) % PROGRESS_EVERY === 0) {
      writeErr(`  queries: ${index + 1}/${queries.length}\r`)
    }
  }
  writeErr(`  queries: ${queries.length}/${queries.length}\n`)
  return { raw, prefixed }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function percent(value: number): string {
  return value.toFixed(3)
}

function seconds(value: number): string {
  return (value / 1000).toFixed(1)
}

function printTable(results: readonly SettingResult[]): void {
  const rows: string[][] = []
  for (const result of results) {
    for (const form of ['raw', 'prefixed'] as const) {
      const metrics = result[form]
      rows.push([
        `${result.width}ch ${result.strip === 'fences' ? 'stripped' : 'raw'} ${form}`,
        String(result.windows),
        percent(metrics.recall1),
        percent(metrics.recall5),
        percent(metrics.recall10),
        percent(metrics.mrr)
      ])
    }
  }
  const header = ['setting', 'windows', 'recall@1', 'recall@5', 'recall@10', 'MRR']
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column].length))
  )
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) =>
        column === 0 ? cell.padEnd(widths[column]) : cell.padStart(widths[column])
      )
      .join('  ')
  write(`${line(header)}\n`)
  for (const row of rows) write(`${line(row)}\n`)
}

function printCosts(
  results: readonly SettingResult[],
  queryRequests: number,
  queryEmbedMs: number
): void {
  const totalWindows = results.reduce((sum, result) => sum + result.windows, 0)
  write(
    `\nEmbedding cost: ${String(totalWindows)} windows plus ${String(queryRequests)} queries ` +
      `(${seconds(queryEmbedMs)}s, shared by every setting)\n`
  )
  for (const result of results) {
    const perWindow = result.windows > 0 ? (result.indexMs / result.windows).toFixed(0) : '-'
    write(
      `  ${String(result.width).padStart(5)}ch ${(result.strip === 'fences' ? 'stripped' : 'raw').padEnd(8)}: ` +
        `${String(result.windows).padStart(5)} windows over ` +
        `${String(result.threadsWithWindows).padStart(3)} threads in ${seconds(result.indexMs)}s ` +
        `(${perWindow} ms/window)\n`
    )
  }
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function run(options: Options): Promise<void> {
  if (options.help) {
    write(usage())
    return
  }

  requireFiles(options)
  const { threads: corpus, skippedShort } = loadCorpus(options.dbPath)
  if (corpus.length === 0)
    fail(`no thread in ${options.dbPath} holds ${MIN_THREAD_CHARS}+ characters.`)

  const sampleRandom = createRandom(options.seed)
  const sampled = sampleThreads(corpus, options.threadCount, sampleRandom)
  const queryRandom = createRandom(options.seed + 0x9e3779b9)
  const queries = buildQueries(sampled, options.queryCount, queryRandom)

  write(`corpus: ${corpus.length} searchable threads`)
  write(` (${skippedShort} skipped as shorter than ${MIN_THREAD_CHARS} chars)\n`)
  write(`sample: ${sampled.length} threads, seed ${options.seed}\n`)
  write(
    `queries: ${queries.length} passages of ${PASSAGE_CHARS} chars starting after char ${MIN_THREAD_CHARS}\n`
  )
  write(`model:   ${options.modelPath}\n\n`)

  server = launchServer(options)
  try {
    write('waiting for llama-server...\n')
    await waitForHealth()
    await readTokenBudget()
    write(`token budget per window: ${Math.max(1, tokenBudget - 1)} tokens\n`)
    const queryStarted = performance.now()
    const queryVectors = await embedQueries(queries)
    const queryEmbedMs = performance.now() - queryStarted
    write(`query embedding: ${seconds(queryEmbedMs)}s\n\n`)

    const results: SettingResult[] = []
    for (const width of options.widths) {
      for (const strip of options.strip) {
        results.push(await measureSetting(width, strip, sampled, queries, queryVectors, options))
      }
    }

    write('\n')
    printTable(results)
    printCosts(results, queries.length * 2, queryEmbedMs)
    write(
      '\nAbsolute recall is optimistic: each query is literal text from the thread it must retrieve. Compare settings, not the values.\n'
    )
  } finally {
    await stopServer()
  }
}

async function shutdown(signal: string): Promise<void> {
  writeErr(`\n${signal}: stopping llama-server...\n`)
  await stopServer()
  process.exit(signal === 'SIGINT' ? 130 : 143)
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})
process.on('exit', () => {
  if (server && !serverExited) server.kill('SIGKILL')
})

const parsed = parseArgs(process.argv.slice(2))
try {
  await run(parsed)
} catch (error) {
  await stopServer()
  writeErr(`error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
