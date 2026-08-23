import { createRequire } from 'node:module'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import ffmpegPath from 'ffmpeg-static'
import { parentPort } from 'node:worker_threads'
import type { SpeechWorkerRequest, SpeechWorkerResponse } from './speech-worker-protocol'

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
  readWave: (path: string) => SherpaWave
  writeWave: (path: string, wave: SherpaWave) => void
}

const port = parentPort
const require = createRequire(import.meta.url)
let loadedModule: SherpaModule | null = null

function sherpa(): SherpaModule {
  if (loadedModule) return loadedModule
  const candidate: unknown = require('sherpa-onnx-node')
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error('The packaged sherpa-onnx module is unavailable.')
  }
  loadedModule = candidate as SherpaModule
  return loadedModule
}

function emit(response: SpeechWorkerResponse): void {
  port?.postMessage(response)
}

async function transcribe(
  request: Extract<SpeechWorkerRequest, { kind: 'transcribe' }>
): Promise<string> {
  const runtime = sherpa()
  const decoderPath = ffmpegPath
  if (!decoderPath) throw new Error('The packaged audio decoder is unavailable.')
  const wavePath = `${request.audioPath}.decoded.wav`
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      decoderPath,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        request.audioPath,
        '-ac',
        '1',
        '-ar',
        '16000',
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
  const recognizer = await runtime.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: join(request.modelDirectory, 'base-encoder.int8.onnx'),
        decoder: join(request.modelDirectory, 'base-decoder.int8.onnx'),
        language: request.language === 'auto' ? '' : request.language,
        task: 'transcribe',
        tailPaddings: -1
      },
      tokens: join(request.modelDirectory, 'base-tokens.txt'),
      numThreads: 2,
      debug: false,
      provider: 'cpu'
    }
  })
  try {
    const stream = recognizer.createStream()
    stream.acceptWaveform(runtime.readWave(wavePath))
    const result = await recognizer.decodeAsync(stream)
    return result.text?.trim() ?? ''
  } finally {
    await rm(wavePath, { force: true })
  }
}

function cleanup(request: Extract<SpeechWorkerRequest, { kind: 'cleanup' }>): string {
  const punctuation = new (sherpa().OfflinePunctuation)({
    model: {
      ctTransformer: join(request.modelDirectory, 'model.onnx'),
      numThreads: 2,
      debug: false,
      provider: 'cpu'
    }
  })
  return punctuation.addPunctuation(request.transcript).trim()
}

async function synthesize(
  request: Extract<SpeechWorkerRequest, { kind: 'synthesize' }>
): Promise<void> {
  const runtime = sherpa()
  const tts = await runtime.OfflineTts.createAsync({
    model: {
      kokoro: {
        model: join(request.modelDirectory, 'model.onnx'),
        voices: join(request.modelDirectory, 'voices.bin'),
        tokens: join(request.modelDirectory, 'tokens.txt'),
        dataDir: request.modelDirectory,
        lengthScale: 1,
        lang: 'en-us'
      }
    },
    maxNumSentences: 1,
    numThreads: 2,
    provider: 'cpu'
  })
  const audio = await tts.generateAsync({
    text: request.text,
    sid: request.speakerId,
    speed: 1,
    enableExternalBuffer: true
  })
  runtime.writeWave(request.outputPath, audio)
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
        if (request.kind === 'transcribe') {
          emit({ id: request.id, ok: true, kind: 'transcribe', text: await transcribe(request) })
          return
        }
        if (request.kind === 'cleanup') {
          emit({ id: request.id, ok: true, kind: 'cleanup', text: cleanup(request) })
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
