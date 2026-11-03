import { constants, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { totalmem } from 'node:os'
import type { EmbeddingRuntimeId } from '../../lib/search/types'
import {
  sharedLocalAiRuntimeRegistry,
  type LocalAiRuntimeRegistry,
  type LocalAiServerHandle
} from '../local-ai/local-ai-runtime-registry'

/** Bound physical attention allocation independently of the user's upper limit. */
export function embeddingWorkingContext(contextTokens: number): number {
  return Math.min(
    contextTokens > 0 ? contextTokens : 8192,
    totalmem() <= 8 * 1024 ** 3 ? 1024 : 2048
  )
}

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
  embed(
    texts: readonly string[],
    signal: AbortSignal,
    options?: EmbeddingCallOptions
  ): Promise<Float32Array[]>
  contextBudget(): Promise<number>
  dispose(): Promise<void>
}

/**
 * Whether this call is a person waiting or background work.
 *
 * Only an interactive call restarts the local AI unload window. A sweep that kept
 * re-arming it would hold the model for the whole session and never let the
 * window the user chose take effect.
 */
export interface EmbeddingCallOptions {
  interactive: boolean
}

/** Hooks the embedding runtime needs to find the server binary it launches. */
export interface EmbeddingRuntimeHost {
  /** Path to the llama.cpp `llama-server` binary, or null when unavailable. */
  llamaServerPath: () => string | null
}

/** Server arguments that never change for one embedding model. */
interface EmbeddingLaunch {
  modelFile: string
  executable: string
  args: string[]
}

/**
 * Runs an embedding model through a local `llama-server` process and reads the
 * OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * The process belongs to the local AI runtime registry, never to this class: the
 * registry shares it per model, unloads it on the user's idle window, and journals
 * it for the next launch. What stays here is the request shape, the token budget,
 * and the serialization of embeddings onto one server.
 */
export class LlamaEmbeddingRuntime implements EmbeddingRuntime {
  readonly id: EmbeddingRuntimeId = 'gguf'
  private handle: LocalAiServerHandle | null = null
  private launch: EmbeddingLaunch | null = null
  private tokenBudget = 0
  private inferenceQueue: Promise<void> = Promise.resolve()

  // Non-causal attention needs a complete physical batch. Bound that working
  // set instead of allocating the entire configured window on small machines.
  private readonly workingContext: number

  constructor(
    private readonly modelDirectory: string,
    private readonly contextTokens: number,
    private readonly host: EmbeddingRuntimeHost,
    private readonly registry: LocalAiRuntimeRegistry = sharedLocalAiRuntimeRegistry()
  ) {
    this.workingContext = embeddingWorkingContext(contextTokens)
  }

  async isAvailable(): Promise<boolean> {
    return this.host.llamaServerPath() !== null
  }

  async contextBudget(): Promise<number> {
    await this.ensureServer({ interactive: false })
    return this.tokenBudget - 1
  }

  async embed(
    texts: readonly string[],
    signal: AbortSignal,
    options: EmbeddingCallOptions = { interactive: true }
  ): Promise<Float32Array[]> {
    const result = this.inferenceQueue.then(() => this.embedSequential(texts, signal, options))
    this.inferenceQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async embedSequential(
    texts: readonly string[],
    signal: AbortSignal,
    options: EmbeddingCallOptions
  ): Promise<Float32Array[]> {
    signal.throwIfAborted()
    if (texts.length === 0) return []
    await this.ensureServer(options)
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
    const port = this.requirePort()
    const response = await fetch(`http://127.0.0.1:${port}/tokenize`, {
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
    const port = this.requirePort()
    const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
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
    return this.handle !== null && this.registry.isAlive(this.handle)
  }

  async dispose(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.tokenBudget = 0
    if (handle) await this.registry.release(handle)
  }

  private requirePort(): number {
    if (!this.isResident() || this.handle === null) {
      throw new Error('The embedding runtime is not running.')
    }
    return this.handle.port
  }

  private async ensureServer(options: EmbeddingCallOptions): Promise<void> {
    const launch = await this.launchSpec()
    const handle = await this.registry.ensureServer({
      runtime: 'llama.cpp',
      modelFile: launch.modelFile,
      port: 0,
      executable: launch.executable,
      args: launch.args,
      cwd: process.cwd(),
      label: 'embedding',
      interactive: options.interactive,
      healthTimeoutMs: 120_000
    })
    const reused = this.handle?.generation === handle.generation
    this.handle = handle
    // The budget is read once per server process: a respawn (the idle window, or
    // a crash) has to read it again, and a reused one must not pay for /props.
    if (reused && this.tokenBudget > 0) return
    await this.readTokenBudget(handle)
  }

  private async launchSpec(): Promise<EmbeddingLaunch> {
    if (this.launch) return this.launch
    const executable = this.host.llamaServerPath()
    if (!executable) throw new Error('No local llama.cpp runtime is available.')
    const modelFile = await locateGgufModel(this.modelDirectory)
    this.launch = {
      executable,
      modelFile,
      args: [
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
      ]
    }
    return this.launch
  }

  private async readTokenBudget(handle: LocalAiServerHandle): Promise<void> {
    // The runtime may cap the requested window to the model's trained limit.
    // Read the actual slot size, including for imports using --ctx-size 0.
    const response = await fetch(`http://127.0.0.1:${handle.port}/props`)
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
