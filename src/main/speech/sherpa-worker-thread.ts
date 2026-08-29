import { createRequire } from 'node:module'
import { open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { parentPort } from 'node:worker_threads'
import type { SpeechWorkerRequest, SpeechWorkerResponse } from './speech-worker-protocol'
import { resolveFfmpegPath } from './ffmpeg-path'
import {
  ASR_BYTES_PER_SAMPLE,
  ASR_CHUNK_SECONDS,
  ASR_SAMPLE_RATE,
  parseWavDataRegion,
  pcmChunkToSamples,
  splitTtsText
} from './asr-audio'

interface SherpaWave {
  samples: Float32Array
  sampleRate: number
}

interface SherpaOfflineStream {
  acceptWaveform: (wave: SherpaWave) => void
}

interface SherpaRecognitionResult {
  text?: string
}

interface SherpaRecognizer {
  createStream: () => SherpaOfflineStream
  decodeAsync: (stream: SherpaOfflineStream) => Promise<SherpaRecognitionResult>
}

interface SherpaRecognizerConstructor {
  createAsync: (config: Record<string, unknown>) => Promise<SherpaRecognizer>
}

interface SherpaPunctuation {
  addPunctuation: (text: string) => string
}

interface SherpaPunctuationConstructor {
  new (config: Record<string, unknown>): SherpaPunctuation
}

interface SherpaGeneratedAudio {
  samples: Float32Array
  sampleRate: number
}

interface SherpaTts {
  generateAsync: (request: Record<string, unknown>) => Promise<SherpaGeneratedAudio>
}

interface SherpaTtsConstructor {
  createAsync: (config: Record<string, unknown>) => Promise<SherpaTts>
}

interface SherpaModule {
  OfflineRecognizer: SherpaRecognizerConstructor
  OfflinePunctuation: SherpaPunctuationConstructor
  OfflineTts: SherpaTtsConstructor
  writeWave: (path: string, wave: SherpaWave) => void
}

type SherpaAsrFamily = 'whisper' | 'parakeet'

/** Per-directory model caches; the worker thread is disposed wholesale on evict, so these never outlive the models they hold. */
const MAX_CACHED_MODELS = 3

const port = parentPort
const nodeRequire = createRequire(import.meta.url)
let loadedModule: SherpaModule | null = null

let cachedRecognizer: {
  directory: string
  modelFamily: SherpaAsrFamily
  recognizer: SherpaRecognizer
} | null = null

const cachedTts = new Map<string, SherpaTts>()
const cachedPunctuation = new Map<string, SherpaPunctuation>()

function sherpa(): SherpaModule {
  if (loadedModule) return loadedModule
  const candidate: unknown = nodeRequire('sherpa-onnx-node')
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('The packaged sherpa-onnx module is unavailable.')
  }
  loadedModule = candidate as SherpaModule
  return loadedModule
}

function rememberModel<T>(cache: Map<string, T>, directory: string, model: T): void {
  if (!cache.has(directory) && cache.size >= MAX_CACHED_MODELS) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(directory, model)
}

function emit(response: SpeechWorkerResponse): void {
  port?.postMessage(response)
}

function runFfmpeg(decoderPath: string, inputPath: string, wavePath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      decoderPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inputPath,
        '-ac',
        '1',
        '-ar',
        String(ASR_SAMPLE_RATE),
        '-c:a',
        'pcm_s16le',
        wavePath
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    let failure = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (failure.length < 2_000) failure += chunk
    })
    child.once('error', reject)
    child.once('exit', (code: number | null) => {
      if (code === 0) resolve()
      else
        reject(new Error(failure.trim() || `Audio decoding exited with code ${code ?? 'unknown'}.`))
    })
  })
}

async function transcribe(
  request: Extract<SpeechWorkerRequest, { kind: 'transcribe' }>
): Promise<string> {
  const decoderPath = await resolveFfmpegPath()
  const wavePath = `${request.audioPath}.decoded.wav`
  try {
    await runFfmpeg(decoderPath, request.audioPath, wavePath)
    const recognizer = await recognizerFor(request.modelDirectory, request.modelFamily)
    const file = await open(wavePath, 'r')
    try {
      const { size } = await file.stat()
      const header = Buffer.alloc(Math.min(size, 64 * 1024))
      await file.read(header, 0, header.length, 0)
      const { dataOffset, dataLength } = parseWavDataRegion(header, size)
      const bytesPerChunk = ASR_CHUNK_SECONDS * ASR_SAMPLE_RATE * ASR_BYTES_PER_SAMPLE
      const chunk = Buffer.allocUnsafe(bytesPerChunk)
      const pieces: string[] = []
      for (let offset = 0; offset < dataLength; offset += bytesPerChunk) {
        const byteLength = Math.min(bytesPerChunk, dataLength - offset)
        const { bytesRead } = await file.read(chunk, 0, byteLength, dataOffset + offset)
        if (bytesRead === 0) break
        const stream = recognizer.createStream()
        stream.acceptWaveform({
          samples: pcmChunkToSamples(chunk, bytesRead),
          sampleRate: ASR_SAMPLE_RATE
        })
        const result = await recognizer.decodeAsync(stream)
        const text = result.text?.trim() ?? ''
        if (text) pieces.push(text)
      }
      return pieces.join(' ')
    } finally {
      await file.close()
    }
  } finally {
    await rm(wavePath, { force: true })
  }
}

async function warmup(request: Extract<SpeechWorkerRequest, { kind: 'warmup' }>): Promise<void> {
  await recognizerFor(request.modelDirectory, request.modelFamily)
}

async function recognizerFor(
  modelDirectory: string,
  requestedFamily: 'whisper' | 'parakeet' | undefined
): Promise<SherpaRecognizer> {
  if (cachedRecognizer && cachedRecognizer.directory === modelDirectory) {
    return cachedRecognizer.recognizer
  }
  const runtime = sherpa()
  const modelFiles = new Set(
    (await readdir(modelDirectory)).map((fileName) => fileName.toLowerCase())
  )
  const modelFamily = resolveAsrFamily(requestedFamily, modelFiles)
  const modelConfig =
    modelFamily === 'parakeet'
      ? {
          transducer: {
            encoder: modelPath(modelFiles, modelDirectory, ['encoder.int8.onnx', 'encoder.onnx'], 'encoder'),
            decoder: modelPath(modelFiles, modelDirectory, ['decoder.int8.onnx', 'decoder.onnx'], 'decoder'),
            joiner: modelPath(modelFiles, modelDirectory, ['joiner.int8.onnx', 'joiner.onnx'], 'joiner')
          },
          tokens: modelPath(modelFiles, modelDirectory, ['tokens.txt'], 'tokens')
        }
      : {
          whisper: {
            encoder: modelPath(
              modelFiles,
              modelDirectory,
              ['base-encoder.int8.onnx', 'base-encoder.onnx', 'encoder.onnx'],
              'Whisper encoder'
            ),
            decoder: modelPath(
              modelFiles,
              modelDirectory,
              ['base-decoder.int8.onnx', 'base-decoder.onnx', 'decoder.onnx'],
              'Whisper decoder'
            ),
            language: '',
            task: 'transcribe',
            tailPaddings: -1
          },
          tokens: modelPath(
            modelFiles,
            modelDirectory,
            ['base-tokens.txt', 'tokens.txt'],
            'Whisper tokens'
          )
        }
  const recognizer = await runtime.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: ASR_SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      ...modelConfig,
      numThreads: 1,
      debug: false,
      provider: 'cpu'
    }
  })
  cachedRecognizer = { directory: modelDirectory, modelFamily, recognizer }
  return recognizer
}

function resolveAsrFamily(
  requestedFamily: 'whisper' | 'parakeet' | undefined,
  modelFiles: ReadonlySet<string>
): SherpaAsrFamily {
  if (requestedFamily) return requestedFamily
  if (modelFiles.has('joiner.int8.onnx') || modelFiles.has('joiner.onnx')) return 'parakeet'
  if (modelFiles.has('base-encoder.int8.onnx') || modelFiles.has('base-encoder.onnx')) {
    return 'whisper'
  }
  throw new Error(
    'Unsupported sherpa-onnx ASR model. Expected Whisper base encoder/decoder/tokens or Parakeet encoder/decoder/joiner/tokens.'
  )
}

function modelPath(
  modelFiles: ReadonlySet<string>,
  directory: string,
  candidates: readonly string[],
  label: string
): string {
  const fileName = candidates.find((candidate) => modelFiles.has(candidate.toLowerCase()))
  if (!fileName) throw new Error(`Sherpa-onnx model is missing its ${label} file.`)
  return join(directory, fileName)
}

async function punctuationFor(modelDirectory: string): Promise<SherpaPunctuation> {
  const cached = cachedPunctuation.get(modelDirectory)
  if (cached) return cached
  const punctuation = new (sherpa().OfflinePunctuation)({
    model: {
      ctTransformer: join(modelDirectory, 'model.onnx'),
      numThreads: 1,
      debug: false,
      provider: 'cpu'
    }
  })
  rememberModel(cachedPunctuation, modelDirectory, punctuation)
  return punctuation
}

async function cleanup(request: Extract<SpeechWorkerRequest, { kind: 'cleanup' }>): Promise<string> {
  const punctuation = await punctuationFor(request.modelDirectory)
  return punctuation.addPunctuation(request.transcript).trim()
}

async function ttsFor(modelDirectory: string): Promise<SherpaTts> {
  const cached = cachedTts.get(modelDirectory)
  if (cached) return cached
  const tts = await sherpa().OfflineTts.createAsync({
    model: {
      kokoro: {
        model: join(modelDirectory, 'model.onnx'),
        voices: join(modelDirectory, 'voices.bin'),
        tokens: join(modelDirectory, 'tokens.txt'),
        dataDir: modelDirectory,
        lengthScale: 1,
        lang: 'en-us'
      }
    },
    maxNumSentences: 1,
    numThreads: 1,
    provider: 'cpu'
  })
  rememberModel(cachedTts, modelDirectory, tts)
  return tts
}

async function synthesize(
  request: Extract<SpeechWorkerRequest, { kind: 'synthesize' }>
): Promise<void> {
  const runtime = sherpa()
  const tts = await ttsFor(request.modelDirectory)
  const pieces = splitTtsText(request.text)
  if (pieces.length === 0) throw new Error('The synthesis request has no readable text.')
  const parts: Float32Array[] = []
  let sampleRate = 0
  for (const piece of pieces) {
    const audio = await tts.generateAsync({
      text: piece,
      sid: request.speakerId,
      speed: 1,
      enableExternalBuffer: false
    })
    parts.push(audio.samples)
    sampleRate = audio.sampleRate
  }
  const audio =
    parts.length === 1
      ? { samples: parts[0], sampleRate }
      : {
          samples: mergeSamples(parts),
          sampleRate
        }
  runtime.writeWave(request.outputPath, audio)
}

function mergeSamples(parts: readonly Float32Array[]): Float32Array {
  let total = 0
  for (const part of parts) total += part.length
  const merged = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.length
  }
  return merged
}

if (port) {
  port.on('message', (request: SpeechWorkerRequest) => {
    void (async () => {
      try {
        if (request.kind === 'shutdown') {
          emit({ id: request.id, ok: true, kind: 'shutdown' })
          port.close()
          return
        }
        if (request.kind === 'warmup') {
          await warmup(request)
          emit({ id: request.id, ok: true, kind: 'warmup' })
          return
        }
        if (request.kind === 'transcribe') {
          emit({ id: request.id, ok: true, kind: 'transcribe', text: await transcribe(request) })
          return
        }
        if (request.kind === 'cleanup') {
          emit({ id: request.id, ok: true, kind: 'cleanup', text: await cleanup(request) })
          return
        }
        await synthesize(request)
        emit({ id: request.id, ok: true, kind: 'synthesize' })
      } catch (cause) {
        emit({
          id: request.id,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause)
        })
      }
    })()
  })
}
