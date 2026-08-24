import type {
  SpeechArchitecture,
  SpeechArtifactBenchmark,
  SpeechArtifactFile,
  SpeechArtifactQualification,
  SpeechCapability,
  SpeechModelArtifact,
  SpeechModelCatalog,
  SpeechModelFamily,
  SpeechModelFamilyId,
  SpeechPlatform,
  SpeechPlatformTarget,
  SpeechRuntime
} from './types'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const REVISION_PATTERN = /^[a-f0-9]{40}$/
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/
const CAPABILITIES = new Set<SpeechCapability>(['asr', 'cleanup', 'tts'])
const RUNTIMES = new Set<SpeechRuntime>(['mlx', 'sherpa-onnx', 'gguf'])
const PLATFORMS = new Set<SpeechPlatform>(['darwin', 'win32', 'linux'])
const ARCHITECTURES = new Set<SpeechArchitecture>(['arm64', 'x64'])
const FAMILY_IDS = new Set<SpeechModelFamilyId>([
  'whisper',
  'parakeet',
  'kokoro',
  'qwen-cleanup',
  'sherpa-punctuation'
])

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty trimmed string.`)
  }
  return value
}

function identifier(value: unknown, label: string): string {
  const result = text(value, label)
  if (!ID_PATTERN.test(result)) throw new TypeError(`${label} is not a valid identifier.`)
  return result
}

function number(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite number greater than or equal to ${minimum}.`)
  }
  return value
}

function integer(value: unknown, label: string, minimum = 0): number {
  const result = number(value, label, minimum)
  if (!Number.isInteger(result)) throw new TypeError(`${label} must be an integer.`)
  return result
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`)
  return value
}

function stringList(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array.`)
  }
  const entries = value.map((item, index) => text(item, `${label}[${index}]`))
  if (new Set(entries).size !== entries.length) {
    throw new TypeError(`${label} must not contain duplicates.`)
  }
  return entries
}

function enumeration<T extends string>(value: unknown, allowed: ReadonlySet<T>, label: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw new TypeError(`${label} is not supported.`)
  }
  return value as T
}

function enumerationList<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string
): T[] {
  return stringList(value, label).map((item, index) =>
    enumeration(item, allowed, `${label}[${index}]`)
  )
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label)
}

function optionalNumber(value: unknown, label: string, minimum = 0): number | undefined {
  return value === undefined ? undefined : number(value, label, minimum)
}

function parseArtifactFile(value: unknown, label: string): SpeechArtifactFile {
  const item = record(value, label)
  const sourceUrl = text(item.sourceUrl, `${label}.sourceUrl`)
  let url: URL
  try {
    url = new URL(sourceUrl)
  } catch {
    throw new TypeError(`${label}.sourceUrl must be an absolute HTTPS URL.`)
  }
  if (url.protocol !== 'https:') {
    throw new TypeError(`${label}.sourceUrl must use HTTPS.`)
  }
  const sha256 = text(item.sha256, `${label}.sha256`)
  if (!SHA256_PATTERN.test(sha256)) {
    throw new TypeError(`${label}.sha256 must be a lowercase SHA-256 digest.`)
  }
  const path = text(item.path, `${label}.path`)
  if (path.startsWith('/') || path.includes('..') || path.includes('\\')) {
    throw new TypeError(`${label}.path must be a safe artifact-relative path.`)
  }
  return {
    path,
    sourceUrl,
    byteSize: integer(item.byteSize, `${label}.byteSize`, 1),
    sha256
  }
}

function parseBenchmark(value: unknown, label: string): SpeechArtifactBenchmark {
  const item = record(value, label)
  const status = enumeration(
    item.status,
    new Set<SpeechArtifactBenchmark['status']>(['pending', 'passed', 'failed']),
    `${label}.status`
  )
  const result: SpeechArtifactBenchmark = {
    status,
    measuredAt: optionalNumber(item.measuredAt, `${label}.measuredAt`, 1),
    hardware: optionalText(item.hardware, `${label}.hardware`),
    operatingSystem: optionalText(item.operatingSystem, `${label}.operatingSystem`),
    peakMemoryBytes: optionalNumber(item.peakMemoryBytes, `${label}.peakMemoryBytes`, 1),
    latencyMs: optionalNumber(item.latencyMs, `${label}.latencyMs`, 0),
    realTimeFactor: optionalNumber(item.realTimeFactor, `${label}.realTimeFactor`, 0),
    qualityMetric: optionalText(item.qualityMetric, `${label}.qualityMetric`),
    qualityScore: optionalNumber(item.qualityScore, `${label}.qualityScore`, 0),
    notes: optionalText(item.notes, `${label}.notes`)
  }
  if (
    status === 'passed' &&
    (result.measuredAt === undefined ||
      result.hardware === undefined ||
      result.operatingSystem === undefined ||
      result.peakMemoryBytes === undefined ||
      result.latencyMs === undefined ||
      result.qualityMetric === undefined ||
      result.qualityScore === undefined)
  ) {
    throw new TypeError(`${label} is passed but its required measurements are incomplete.`)
  }
  return result
}

function parseQualification(value: unknown, label: string): SpeechArtifactQualification {
  const item = record(value, label)
  const status = enumeration(
    item.status,
    new Set<SpeechArtifactQualification['status']>(['candidate', 'qualified', 'retired']),
    `${label}.status`
  )
  const result: SpeechArtifactQualification = {
    status,
    reviewedAt: optionalNumber(item.reviewedAt, `${label}.reviewedAt`, 1),
    reviewer: optionalText(item.reviewer, `${label}.reviewer`),
    licenseReviewed: boolean(item.licenseReviewed, `${label}.licenseReviewed`),
    compatibilityReviewed: boolean(item.compatibilityReviewed, `${label}.compatibilityReviewed`),
    checksumReviewed: boolean(item.checksumReviewed, `${label}.checksumReviewed`),
    benchmark: parseBenchmark(item.benchmark, `${label}.benchmark`)
  }
  if (
    status === 'qualified' &&
    (result.reviewedAt === undefined ||
      result.reviewer === undefined ||
      !result.licenseReviewed ||
      !result.compatibilityReviewed ||
      !result.checksumReviewed ||
      result.benchmark.status !== 'passed')
  ) {
    throw new TypeError(`${label} is qualified but one or more admission gates are incomplete.`)
  }
  return result
}

function parseFamily(value: unknown, label: string): SpeechModelFamily {
  const item = record(value, label)
  return {
    id: enumeration(item.id, FAMILY_IDS, `${label}.id`),
    capability: enumeration(item.capability, CAPABILITIES, `${label}.capability`),
    label: text(item.label, `${label}.label`),
    description: text(item.description, `${label}.description`),
    artifactIds: stringList(item.artifactIds, `${label}.artifactIds`).map((id, index) =>
      identifier(id, `${label}.artifactIds[${index}]`)
    )
  }
}

function parseArtifact(value: unknown, label: string): SpeechModelArtifact {
  const item = record(value, label)
  const repositoryRevision = text(item.repositoryRevision, `${label}.repositoryRevision`)
  if (!REVISION_PATTERN.test(repositoryRevision)) {
    throw new TypeError(`${label}.repositoryRevision must be a pinned 40-character commit SHA.`)
  }
  const filesValue = item.files
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    throw new TypeError(`${label}.files must be a non-empty array.`)
  }
  const files = filesValue.map((file, index) => parseArtifactFile(file, `${label}.files[${index}]`))
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new TypeError(`${label}.files contains duplicate paths.`)
  }
  const byteSize = integer(item.byteSize, `${label}.byteSize`, 1)
  const fileBytes = files.reduce((total, file) => total + file.byteSize, 0)
  if (fileBytes !== byteSize) {
    throw new TypeError(`${label}.byteSize must equal the sum of its file byte sizes.`)
  }
  const sourcePageUrl = text(item.sourcePageUrl, `${label}.sourcePageUrl`)
  if (!sourcePageUrl.startsWith('https://')) {
    throw new TypeError(`${label}.sourcePageUrl must use HTTPS.`)
  }
  const runtime = enumeration(item.runtime, RUNTIMES, `${label}.runtime`)
  const platforms = enumerationList(item.platforms, PLATFORMS, `${label}.platforms`)
  const architectures = enumerationList(item.architectures, ARCHITECTURES, `${label}.architectures`)
  if (runtime === 'mlx' && (platforms.length !== 1 || platforms[0] !== 'darwin')) {
    throw new TypeError(`${label} uses MLX but declares a non-Darwin platform.`)
  }
  if (runtime === 'mlx' && (architectures.length !== 1 || architectures[0] !== 'arm64')) {
    throw new TypeError(`${label} uses MLX but declares a non-arm64 architecture.`)
  }
  return {
    id: identifier(item.id, `${label}.id`),
    familyId: enumeration(item.familyId, FAMILY_IDS, `${label}.familyId`),
    capability: enumeration(item.capability, CAPABILITIES, `${label}.capability`),
    runtime,
    label: text(item.label, `${label}.label`),
    description: text(item.description, `${label}.description`),
    tier: enumeration(
      item.tier,
      new Set<SpeechModelArtifact['tier']>(['lightweight', 'balanced', 'quality']),
      `${label}.tier`
    ),
    version: text(item.version, `${label}.version`),
    repositoryRevision,
    platforms,
    architectures,
    languages: stringList(item.languages, `${label}.languages`),
    voices: stringList(item.voices, `${label}.voices`, true),
    files,
    byteSize,
    license: text(item.license, `${label}.license`),
    attribution: text(item.attribution, `${label}.attribution`),
    sourcePageUrl,
    minimumMemoryBytes: integer(item.minimumMemoryBytes, `${label}.minimumMemoryBytes`, 1),
    qualification: parseQualification(item.qualification, `${label}.qualification`)
  }
}

export function parseSpeechModelCatalog(value: unknown): SpeechModelCatalog {
  const catalog = record(value, 'Speech model catalog')
  if (catalog.version !== 1) throw new TypeError('Speech model catalog version must be 1.')
  if (!Array.isArray(catalog.families) || catalog.families.length === 0) {
    throw new TypeError('Speech model catalog families must be a non-empty array.')
  }
  if (!Array.isArray(catalog.artifacts) || catalog.artifacts.length === 0) {
    throw new TypeError('Speech model catalog artifacts must be a non-empty array.')
  }
  const families = catalog.families.map((family, index) =>
    parseFamily(family, `Speech model catalog families[${index}]`)
  )
  const artifacts = catalog.artifacts.map((artifact, index) =>
    parseArtifact(artifact, `Speech model catalog artifacts[${index}]`)
  )
  if (new Set(families.map((family) => family.id)).size !== families.length) {
    throw new TypeError('Speech model catalog family IDs must be unique.')
  }
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) {
    throw new TypeError('Speech model catalog artifact IDs must be unique.')
  }
  const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  for (const family of families) {
    for (const artifactId of family.artifactIds) {
      const artifact = artifactById.get(artifactId)
      if (!artifact)
        throw new TypeError(
          `Speech model family ${family.id} references ${artifactId}, which does not exist.`
        )
      if (artifact.familyId !== family.id || artifact.capability !== family.capability) {
        throw new TypeError(
          `Speech model artifact ${artifactId} does not match family ${family.id}.`
        )
      }
    }
  }
  for (const artifact of artifacts) {
    const family = families.find((candidate) => candidate.id === artifact.familyId)
    if (!family?.artifactIds.includes(artifact.id)) {
      throw new TypeError(`Speech model artifact ${artifact.id} is not linked from its family.`)
    }
  }
  return {
    version: 1,
    generatedAt: integer(catalog.generatedAt, 'Speech model catalog generatedAt', 1),
    families,
    artifacts
  }
}

export function compatibleSpeechArtifacts(
  catalog: SpeechModelCatalog,
  capability: SpeechCapability,
  runtime: SpeechRuntime,
  target: SpeechPlatformTarget,
  includeCandidates = false
): SpeechModelArtifact[] {
  return catalog.artifacts.filter(
    (artifact) =>
      artifact.capability === capability &&
      artifact.runtime === runtime &&
      artifact.platforms.includes(target.platform) &&
      artifact.architectures.includes(target.architecture) &&
      (includeCandidates || artifact.qualification.status === 'qualified')
  )
}
