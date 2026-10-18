import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import type { EmbeddingRuntimeId } from '../../lib/search/types'
import { buildProcessEnvironment } from '../drivers/cli-environment'

/** Bound physical attention allocation independently of the user's upper limit. */
export function embeddingWorkingContext(contextTokens: number): number {
  return Math.min(
    contextTokens > 0 ? contextTokens : 8192,
    totalmem() <= 8 * 1024 ** 3 ? 1024 : 2048
  )
}

/**
 * How long a resident embedding model stays in memory after its last use.
 *
 * Five minutes: long enough that one working session keeps the model hot across
 * searches, short enough that an app left open does not hold the model's memory
 * for a feature the user has walked away from. The next use boots it again (or a
 * warm-up does), and the spotlight's search never waits on that boot because its
 * keyword rows are already on screen.
 */
export const EMBEDDING_RUNTIME_IDLE_MS = 5 * 60_000

/**
 * A local embedding runtime: turns text into vectors without leaving the
 * machine. Implementations are selected per installed model's runtime id, so
 * the subsystem is not tied to one format or backend.
 */
export interface EmbeddingRuntime {
  readonly id: EmbeddingRuntimeId
  /** Whether the runtime can actually run on this machine right now. */
  isAvailable(): Promise<boolean>
  /**
   * Whether the model is loaded and a query could embed without a boot.
   *
   * A boot is tens of seconds of model loading (measured: 22 s for the shipped
   * EmbeddingGemma model on CPU), so callers that have to answer an interactive
   * request ask this first and warm the runtime in the background instead.
   */
  isResident(): boolean
  /** Embed a batch of texts. Order of the result matches the input order. */
  embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]>
  contextBudget(): Promise<number>
  dispose(): Promise<void>
}

/** Hooks the embedding runtime needs to spawn and track its server process. */
export interface EmbeddingRuntimeHost {
  /** Path to the llama.cpp `llama-server` binary, or null when unavailable. */
  llamaServerPath: () => string | null
  registerProcess: (pid: number, command: string, cwd: string) => void
  unregisterProcess: (pid: number) => void
}

/**
 * Runs an embedding model through a local `llama-server` process and reads the
 * OpenAI-compatible `/v1/embeddings` endpoint. One server stays resident per
 * selected model and is reused across batches.
 */
export class LlamaEmbeddingRuntime implements EmbeddingRuntime {
  readonly id: EmbeddingRuntimeId = 'gguf'
  private child: ChildProcessWithoutNullStreams | null = null
  private port = 0
  private stderrTail = ''
  private ready: Promise<void> | null = null
  private tokenBudget = 0
  private inferenceQueue: Promise<void> = Promise.resolve()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  // Non-causal attention needs a complete physical batch. Bound that working
  // set instead of allocating the entire configured window on small machines.
  private readonly workingContext: number

  constructor(
    private readonly modelDirectory: string,
    private readonly contextTokens: number,
    private readonly host: EmbeddingRuntimeHost
  ) {
    this.workingContext = embeddingWorkingContext(contextTokens)
  }

  async isAvailable(): Promise<boolean> {
    return this.host.llamaServerPath() !== null
  }

  async contextBudget(): Promise<number> {
    await this.ensureServer()
    return this.tokenBudget - 1
  }

  async embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]> {
    const result = this.inferenceQueue.then(async () => {
      try {
        return await this.embedSequential(texts, signal)
      } finally {
        if (this.child) {
          if (this.idleTimer) clearTimeout(this.idleTimer)
          this.idleTimer = setTimeout(() => {
            void this.dispose()
          }, EMBEDDING_RUNTIME_IDLE_MS)
          this.idleTimer.unref()
        }
      }
    })
    this.inferenceQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async embedSequential(
    texts: readonly string[],
    signal: AbortSignal
  ): Promise<Float32Array[]> {
    signal.throwIfAborted()
    if (texts.length === 0) return []
    await this.ensureServer()
    // Non-causal embeddings must fit in one physical batch. Process documents
    // sequentially so an index batch cannot multiply the runtime's memory use.
    const vectors: Float32Array[] = []
    for (const text of texts) {
      signal.throwIfAborted()
      const tokens = await this.tokenize(text, signal)
      const vector = await this.embedTokens(tokens.slice(0, this.tokenBudget - 1), signal)
      vectors.push(vector)
    }
    return vectors
  }

  private async tokenize(text: string, signal: AbortSignal): Promise<number[]> {
    const response = await fetch(`http://127.0.0.1:${this.port}/tokenize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: text, add_special: true }),
      signal
    })
    await requireSuccessfulResponse(response)
    const value: unknown = await response.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      !('tokens' in value) ||
      !Array.isArray(value.tokens) ||
      !value.tokens.every(
        (token: unknown) => typeof token === 'number' && Number.isInteger(token) && token >= 0
      )
    ) {
      throw new Error('The embedding tokenizer returned invalid tokens.')
    }
    return value.tokens
  }

  private async embedTokens(tokens: number[], signal: AbortSignal): Promise<Float32Array> {
    if (this.port === 0) throw new Error('The embedding runtime is not running.')
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: [tokens], encoding_format: 'float' }),
      signal
    })
    await requireSuccessfulResponse(response)
    const value: unknown = await response.json()
    if (
      typeof value !== 'object' ||
      value === null ||
      !('data' in value) ||
      !Array.isArray(value.data) ||
      value.data.length !== 1
    ) {
      throw new Error('The embedding model returned an unexpected number of vectors.')
    }
    const row: unknown = value.data[0]
    if (
      typeof row !== 'object' ||
      row === null ||
      !('embedding' in row) ||
      !Array.isArray(row.embedding) ||
      row.embedding.length === 0 ||
      !row.embedding.every(
        (number: unknown) => typeof number === 'number' && Number.isFinite(number)
      )
    ) {
      throw new Error('The embedding model returned an invalid vector.')
    }
    return Float32Array.from(row.embedding)
  }

  isResident(): boolean {
    return this.child !== null
  }

  async dispose(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const child = this.child
    this.child = null
    this.port = 0
    this.ready = null
    this.tokenBudget = 0
    child?.kill('SIGTERM')
  }

  private async ensureServer(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.child && this.tokenBudget > 0) return
    this.ready ??= this.start()
    try {
      await this.ready
    } catch (error) {
      await this.dispose()
      throw error
    }
  }

  private async start(): Promise<void> {
    const executable = this.host.llamaServerPath()
    if (!executable) throw new Error('No local llama.cpp runtime is available.')
    const modelFile = await locateGgufModel(this.modelDirectory)
    this.stderrTail = ''
    // llama-server picks its own free TCP port with --port 0 and reports the
    // listening URL on stderr before the model finishes loading.
    const child = spawn(
      executable,
      [
        '--model',
        modelFile,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        '--ctx-size',
        String(this.workingContext),
        // Mean pooling cannot split a document across physical batches.
        '--batch-size',
        String(this.workingContext),
        '--ubatch-size',
        String(this.workingContext),
        // Keep background inference off the GPU to avoid contending with UI rendering.
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
        // Serve the OpenAI-compatible /v1/embeddings endpoint. Pooling and
        // normalization come from the model's own metadata, which is correct
        // for EmbeddingGemma and for user-imported embedding models alike.
        '--embeddings'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env: buildProcessEnvironment() }
    ) as unknown as ChildProcessWithoutNullStreams
    this.child = child
    const pid = child.pid ?? 0
    this.host.registerProcess(pid, executable, process.cwd())
    child.once('exit', () => {
      this.host.unregisterProcess(pid)
      if (this.child === child) {
        this.child = null
        this.port = 0
        this.ready = null
        this.tokenBudget = 0
      }
    })
    let buffered = ''
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error('llama-server did not report its port.')),
        30_000
      )
      const finish = (failure?: Error): void => {
        clearTimeout(timeout)
        if (failure) reject(failure)
        else resolve()
      }
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000)
        buffered = `${buffered}${chunk}`.slice(-4000)
        const match = /(?:http|https):\/\/[^\s]+:(\d+)/u.exec(buffered)
        if (!match || !match[1]) return
        this.port = Number(match[1])
        finish()
      })
      child.once('error', (error) => finish(error))
      child.once('exit', () =>
        finish(new Error(this.stderrTail.trim() || 'llama-server exited early.'))
      )
    })
    await this.waitHealthy()
    // The runtime may cap the requested window to the model's trained limit.
    // Read the actual slot size, including for imports using --ctx-size 0.
    const response = await fetch(`http://127.0.0.1:${this.port}/props`)
    await requireSuccessfulResponse(response)
    const properties: unknown = await response.json()
    if (
      typeof properties !== 'object' ||
      properties === null ||
      !('default_generation_settings' in properties) ||
      typeof properties.default_generation_settings !== 'object' ||
      properties.default_generation_settings === null ||
      !('n_ctx' in properties.default_generation_settings) ||
      typeof properties.default_generation_settings.n_ctx !== 'number' ||
      !Number.isInteger(properties.default_generation_settings.n_ctx) ||
      properties.default_generation_settings.n_ctx < 2
    ) {
      throw new Error('The embedding runtime did not report its context window.')
    }
    this.tokenBudget = Math.min(
      properties.default_generation_settings.n_ctx,
      this.contextTokens > 0 ? this.contextTokens : 8192
    )
  }

  private async waitHealthy(): Promise<void> {
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`)
        if (response.ok) return
      } catch {
        // Server still booting; retry below.
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    throw new Error('llama-server did not become healthy after loading the embedding model.')
  }
}

async function requireSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return
  const body = (await response.text()).slice(0, 2000)
  let detail = ''
  try {
    const value: unknown = JSON.parse(body)
    if (
      typeof value === 'object' &&
      value !== null &&
      'error' in value &&
      typeof value.error === 'object' &&
      value.error !== null &&
      'message' in value.error &&
      typeof value.error.message === 'string'
    ) {
      detail = value.error.message
    }
  } catch {
    // Non-JSON errors still retain their bounded diagnostic text.
    detail = body
  }
  throw new Error(
    `The embedding model request failed (${response.status})${detail ? `: ${detail}` : '.'}`
  )
}

async function locateGgufModel(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!entry.name.toLowerCase().endsWith('.gguf')) continue
    const candidate = join(directory, entry.name)
    await access(candidate, constants.R_OK)
    return candidate
  }
  throw new Error('The embedding model folder does not contain a GGUF file.')
}
