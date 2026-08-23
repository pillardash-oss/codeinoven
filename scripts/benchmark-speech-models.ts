import { isAbsolute, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { Logger } from '../src/main/system/logger'
import { parseSpeechModelCatalog } from '../src/lib/speech/model-catalog'
import { SPEECH_PLATFORM_DEFAULTS } from '../src/lib/speech/types'

interface Options {
  catalogPath: string
  artifactId?: string
  runnerPath?: string
  samplePaths: string[]
  repeats: number
}

interface RunnerMeasurement {
  artifactId: string
  hardware: string
  operatingSystem: string
  peakMemoryBytes: number
  latencyMs: number
  realTimeFactor?: number
  qualityMetric: string
  qualityScore: number
}

const MAX_SAMPLES = 20
const MAX_REPEATS = 5
const RUN_TIMEOUT_MS = 10 * 60 * 1000

function fail(message: string): never {
  Logger.error(`[benchmark-speech-models] ${message}`)
  process.exit(1)
}

function readValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) fail(`${flag} requires a value.`)
  return value
}

function parseArgs(args: string[]): Options {
  let catalogPath = 'resources/speech/model-catalog.json'
  let artifactId: string | undefined
  let runnerPath: string | undefined
  const samplePaths: string[] = []
  let repeats = 1

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--catalog') {
      catalogPath = readValue(args, index, flag)
      index += 1
    } else if (flag === '--artifact') {
      artifactId = readValue(args, index, flag)
      index += 1
    } else if (flag === '--runner') {
      runnerPath = readValue(args, index, flag)
      index += 1
    } else if (flag === '--sample') {
      samplePaths.push(readValue(args, index, flag))
      index += 1
    } else if (flag === '--repeats') {
      repeats = Number.parseInt(readValue(args, index, flag), 10)
      index += 1
    } else {
      fail(`Unknown option: ${flag}`)
    }
  }

  if (!Number.isInteger(repeats) || repeats < 1 || repeats > MAX_REPEATS) {
    fail(`--repeats must be between 1 and ${MAX_REPEATS}.`)
  }
  if (samplePaths.length > MAX_SAMPLES) fail(`At most ${MAX_SAMPLES} samples are allowed.`)
  if ((artifactId === undefined) !== (runnerPath === undefined)) {
    fail('--artifact and --runner must be provided together.')
  }
  if (runnerPath !== undefined && !isAbsolute(runnerPath)) {
    fail('--runner must be an explicit absolute path.')
  }

  return { catalogPath, artifactId, runnerPath, samplePaths, repeats }
}

function parseMeasurement(value: unknown, artifactId: string): RunnerMeasurement {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('The benchmark worker returned an invalid JSON object.')
  }
  const input = value as Record<string, unknown>
  const requiredText = (key: 'artifactId' | 'hardware' | 'operatingSystem' | 'qualityMetric') => {
    const entry = input[key]
    if (typeof entry !== 'string' || entry.length === 0) fail(`Worker result ${key} is invalid.`)
    return entry
  }
  const requiredNumber = (key: 'peakMemoryBytes' | 'latencyMs' | 'qualityScore') => {
    const entry = input[key]
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0) {
      fail(`Worker result ${key} is invalid.`)
    }
    return entry
  }
  const measuredArtifactId = requiredText('artifactId')
  if (measuredArtifactId !== artifactId) fail('Worker result belongs to a different artifact.')
  const realTimeFactor = input.realTimeFactor
  if (
    realTimeFactor !== undefined &&
    (typeof realTimeFactor !== 'number' || !Number.isFinite(realTimeFactor) || realTimeFactor < 0)
  ) {
    fail('Worker result realTimeFactor is invalid.')
  }
  return {
    artifactId: measuredArtifactId,
    hardware: requiredText('hardware'),
    operatingSystem: requiredText('operatingSystem'),
    peakMemoryBytes: requiredNumber('peakMemoryBytes'),
    latencyMs: requiredNumber('latencyMs'),
    qualityMetric: requiredText('qualityMetric'),
    qualityScore: requiredNumber('qualityScore'),
    ...(realTimeFactor === undefined ? {} : { realTimeFactor })
  }
}

async function runBenchmark(options: Options): Promise<void> {
  const catalogFile = Bun.file(resolve(options.catalogPath))
  if (!(await catalogFile.exists())) fail(`Catalog not found: ${options.catalogPath}`)
  const catalog = parseSpeechModelCatalog(await catalogFile.json())

  Logger.info(`[benchmark-speech-models] Catalog v${catalog.version} is valid.`)
  for (const row of SPEECH_PLATFORM_DEFAULTS) {
    Logger.info(
      `[benchmark-speech-models] ${row.target.platform}/${row.target.architecture}: ${row.runtime}`
    )
  }

  if (!options.artifactId || !options.runnerPath) {
    const candidates = catalog.artifacts.filter(
      (artifact) => artifact.qualification.status === 'candidate'
    )
    Logger.info(
      `[benchmark-speech-models] ${candidates.length} candidate artifacts remain blocked pending qualification.`
    )
    return
  }

  const artifact = catalog.artifacts.find((candidate) => candidate.id === options.artifactId)
  if (!artifact) fail(`Artifact not found: ${options.artifactId}`)
  const runner = await stat(options.runnerPath).catch(() => null)
  if (!runner?.isFile()) fail(`Benchmark runner not found: ${options.runnerPath}`)
  for (const samplePath of options.samplePaths) {
    const sample = await stat(resolve(samplePath)).catch(() => null)
    if (!sample?.isFile()) fail(`Benchmark sample not found: ${samplePath}`)
  }

  for (let repeat = 0; repeat < options.repeats; repeat += 1) {
    const processHandle = Bun.spawn(
      [
        options.runnerPath,
        'benchmark',
        '--artifact',
        artifact.id,
        ...options.samplePaths.flatMap((path) => ['--sample', resolve(path)]),
        '--json'
      ],
      { stderr: 'pipe', stdout: 'pipe', stdin: 'ignore' }
    )
    const timeout = setTimeout(() => processHandle.kill(), RUN_TIMEOUT_MS)
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text()
    ])
    clearTimeout(timeout)
    if (exitCode !== 0) fail(`Worker exited with ${exitCode}: ${stderr.trim() || 'no detail'}`)
    const measurement = parseMeasurement(JSON.parse(stdout) as unknown, artifact.id)
    Logger.info(
      `[benchmark-speech-models] ${artifact.id} run ${repeat + 1}/${options.repeats}: ${JSON.stringify(measurement)}`
    )
  }
}

await runBenchmark(parseArgs(Bun.argv.slice(2)))
