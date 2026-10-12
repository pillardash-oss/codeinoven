import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants, access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { EmbeddingRuntimeId } from '../../lib/search/types'

/**
 * A local embedding runtime: turns text into vectors without leaving the
 * machine. Implementations are selected per installed model's runtime id, so
 * the subsystem is not tied to one format or backend.
 */
export interface EmbeddingRuntime {
  readonly id: EmbeddingRuntimeId
  /** Whether the runtime can actually run on this machine right now. */
  isAvailable(): Promise<boolean>
  /** Embed a batch of texts. Order of the result matches the input order. */
  embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]>
  dispose(): Promise<void>
}

/** Hooks the embedding runtime needs to spawn and track its server process. */
export interface EmbeddingRuntimeHost {
  /** Path to the llama.cpp `llama-server` binary, or null when unavailable. */
  llamaServerPath: () => string | null
  registerProcess: (pid: number, command: string, cwd: string) => void
  unregisterProcess: (pid: number) => void
}

interface EmbeddingResponseRow {
  index?: number
  embedding?: number[]
}

interface EmbeddingResponse {
  data?: EmbeddingResponseRow[]
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

  constructor(
    private readonly modelDirectory: string,
    private readonly contextTokens: number,
    private readonly host: EmbeddingRuntimeHost
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.host.llamaServerPath() !== null
  }

  async embed(texts: readonly string[], signal: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    await this.ensureServer()
    if (this.port === 0) throw new Error('The embedding runtime is not running.')
    const response = await fetch(`http://127.0.0.1:${this.port}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: [...texts], encoding_format: 'float' }),
      signal
    })
    if (!response.ok) {
      throw new Error(`The embedding model request failed (${response.status}).`)
    }
    const value = (await response.json()) as EmbeddingResponse
    const rows = value.data ?? []
    if (rows.length !== texts.length) {
      throw new Error('The embedding model returned an unexpected number of vectors.')
    }
    const ordered: Float32Array[] = new Array(texts.length)
    rows.forEach((row, fallbackIndex) => {
      const target = typeof row.index === 'number' ? row.index : fallbackIndex
      if (!row.embedding) throw new Error('The embedding model returned an empty vector.')
      ordered[target] = Float32Array.from(row.embedding)
    })
    for (let index = 0; index < ordered.length; index += 1) {
      if (!ordered[index]) throw new Error('The embedding model returned an incomplete batch.')
    }
    return ordered
  }

  isResident(): boolean {
    return this.child !== null
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = null
    this.port = 0
    this.ready = null
    child?.kill('SIGTERM')
  }

  private async ensureServer(): Promise<void> {
    if (this.child && this.port !== 0) return
    this.ready ??= this.start()
    try {
      await this.ready
    } catch (error) {
      this.ready = null
      throw error
    }
  }

  private async start(): Promise<void> {
    const executable = this.host.llamaServerPath()
    if (!executable) throw new Error('No local llama.cpp runtime is available.')
    const modelFile = await locateGgufModel(this.modelDirectory)
    await this.dispose()
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
        // `0` lets llama.cpp adopt the model's own trained context, which is the
        // only correct answer for an imported model whose window we cannot know.
        this.contextTokens > 0 ? String(this.contextTokens) : '0',
        '--parallel',
        '1',
        // Serve the OpenAI-compatible /v1/embeddings endpoint. Pooling and
        // normalization come from the model's own metadata, which is correct
        // for EmbeddingGemma and for user-imported embedding models alike.
        '--embeddings'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ) as unknown as ChildProcessWithoutNullStreams
    this.child = child
    const pid = child.pid ?? 0
    this.host.registerProcess(pid, executable, process.cwd())
    child.once('exit', () => this.host.unregisterProcess(pid))
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
        buffered += chunk
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
