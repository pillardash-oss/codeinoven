export const SPEECH_HISTORY_LIMIT_MIN = 1
export const SPEECH_HISTORY_LIMIT_MAX = 500
export const DEFAULT_SPEECH_HISTORY_LIMIT = 30
export const MAX_SPEECH_CHUNK_BYTES = 512 * 1024
export const MAX_SPEECH_QUEUE_DEPTH = 8
export const MAX_GLOBAL_CORRECTION_RULES = 500
export const MAX_CONTEXT_CORRECTION_RULES = 200

export type SpeechRuntime = 'mlx' | 'sherpa-onnx'
export type SpeechCapability = 'asr' | 'cleanup' | 'tts'
export type SpeechPlatform = 'darwin' | 'win32' | 'linux'
export type SpeechArchitecture = 'arm64' | 'x64'
export type SpeechScope =
  { kind: 'global' } | { kind: 'project'; projectId: string } | { kind: 'inbox' }

export interface SpeechPlatformTarget {
  platform: SpeechPlatform
  architecture: SpeechArchitecture
}

export const SPEECH_PLATFORM_DEFAULTS: ReadonlyArray<{
  target: SpeechPlatformTarget
  runtime: SpeechRuntime
}> = [
  { target: { platform: 'darwin', architecture: 'arm64' }, runtime: 'mlx' },
  { target: { platform: 'darwin', architecture: 'x64' }, runtime: 'sherpa-onnx' },
  { target: { platform: 'win32', architecture: 'x64' }, runtime: 'sherpa-onnx' },
  { target: { platform: 'linux', architecture: 'x64' }, runtime: 'sherpa-onnx' },
  { target: { platform: 'linux', architecture: 'arm64' }, runtime: 'sherpa-onnx' }
]

export interface SpeechRuntimeAvailability {
  runtime: SpeechRuntime
  available: boolean
  reason?: string
}

export interface SpeechRuntimeResolution {
  runtime: SpeechRuntime
  source: 'platform-default' | 'user-override'
  target: SpeechPlatformTarget
}

export type SpeechCompatibilityErrorCode =
  | 'runtime-unavailable'
  | 'runtime-unsupported'
  | 'model-unavailable'
  | 'model-incompatible'
  | 'model-not-qualified'
  | 'voice-unsupported'

export interface SpeechCompatibilityError {
  kind: 'compatibility-error'
  code: SpeechCompatibilityErrorCode
  message: string
  runtime?: SpeechRuntime
  artifactId?: string
  target?: SpeechPlatformTarget
}

export type SpeechRuntimeResolutionResult =
  { ok: true; value: SpeechRuntimeResolution } | { ok: false; error: SpeechCompatibilityError }

export type SpeechModelFamilyId = 'whisper' | 'kokoro' | 'qwen-cleanup' | 'sherpa-punctuation'
export type SpeechArtifactStatus = 'candidate' | 'qualified' | 'retired'

export interface SpeechArtifactFile {
  path: string
  sourceUrl: string
  byteSize: number
  sha256: string
}

export interface SpeechArtifactBenchmark {
  status: 'pending' | 'passed' | 'failed'
  measuredAt?: number
  hardware?: string
  operatingSystem?: string
  peakMemoryBytes?: number
  latencyMs?: number
  realTimeFactor?: number
  qualityMetric?: string
  qualityScore?: number
  notes?: string
}

export interface SpeechArtifactQualification {
  status: SpeechArtifactStatus
  reviewedAt?: number
  reviewer?: string
  licenseReviewed: boolean
  compatibilityReviewed: boolean
  checksumReviewed: boolean
  benchmark: SpeechArtifactBenchmark
}

export interface SpeechModelArtifact {
  id: string
  familyId: SpeechModelFamilyId
  capability: SpeechCapability
  runtime: SpeechRuntime
  label: string
  description: string
  tier: 'lightweight' | 'balanced' | 'quality'
  version: string
  repositoryRevision: string
  platforms: SpeechPlatform[]
  architectures: SpeechArchitecture[]
  languages: string[]
  voices: string[]
  files: SpeechArtifactFile[]
  byteSize: number
  license: string
  attribution: string
  sourcePageUrl: string
  minimumMemoryBytes: number
  qualification: SpeechArtifactQualification
}

export interface SpeechModelFamily {
  id: SpeechModelFamilyId
  capability: SpeechCapability
  label: string
  description: string
  artifactIds: string[]
}

export interface SpeechModelCatalog {
  version: 1
  generatedAt: number
  families: SpeechModelFamily[]
  artifacts: SpeechModelArtifact[]
}

export type SpeechDownloadState =
  | { state: 'idle' }
  | { state: 'queued'; position: number }
  | { state: 'downloading'; bytesReceived: number; totalBytes: number }
  | { state: 'verifying'; bytesReceived: number; totalBytes: number }
  | { state: 'installed'; installedAt: number }
  | { state: 'cancelled'; cancelledAt: number }
  | { state: 'failed'; failedAt: number; error: SpeechError }

export interface SpeechInstalledArtifact {
  artifactId: string
  runtime: SpeechRuntime
  revision: string
  installedAt: number
  byteSize: number
  source: 'download' | 'import'
  externalReference: boolean
  available: boolean
  unavailableReason?: string
}

export type SpeechAttemptStage =
  | 'permission'
  | 'recording'
  | 'stopping'
  | 'transcribing'
  | 'cleaning'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface SpeechAttemptError {
  stage: SpeechAttemptStage
  error: SpeechError
  occurredAt: number
}

export interface SpeechRetryRecord {
  id: string
  createdAt: number
  completedAt?: number
  runtime: SpeechRuntime
  artifactId: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  rawTranscript?: string
  cleanedTranscript?: string
  error?: SpeechError
}

export interface SpeechRecordingAttempt {
  id: string
  createdAt: number
  updatedAt: number
  stage: SpeechAttemptStage
  scope: SpeechScope
  runtime?: SpeechRuntime
  artifactId?: string
  audioId?: string
  audioAvailable: boolean
  durationMs?: number
  byteSize: number
  mimeType?: string
  rawTranscript?: string
  cleanedTranscript?: string
  finalTranscript?: string
  cleanupProvenance?: SpeechCleanupProvenance
  retries: SpeechRetryRecord[]
  errors: SpeechAttemptError[]
}

export type SpeechCaptureState =
  | { state: 'idle' }
  | { state: 'requesting-permission' }
  | { state: 'recording'; sessionId: string; attemptId: string; startedAt: number }
  | { state: 'stopping'; sessionId: string; attemptId: string }
  | { state: 'transcribing'; jobId: string; attemptId: string }
  | { state: 'cleaning'; jobId: string; attemptId: string }
  | { state: 'failed'; attemptId?: string; error: SpeechError }

export type SpeechJobState =
  | { state: 'queued'; position: number }
  | { state: 'running'; startedAt: number }
  | { state: 'succeeded'; completedAt: number }
  | { state: 'failed'; completedAt: number; error: SpeechError }
  | { state: 'cancelled'; completedAt: number }

export interface SpeechTranscriptionJob {
  id: string
  attemptId: string
  runtime: SpeechRuntime
  artifactId: string
  language: string | 'auto'
  state: SpeechJobState
}

export type SpeechCleanupMode =
  | { kind: 'disabled' }
  | { kind: 'local'; artifactId?: string }
  | { kind: 'remote'; selection: 'fixed' | 'conversation'; modelId?: string }

export interface SpeechCleanupRequest {
  attemptId: string
  transcript: string
  mode: SpeechCleanupMode
  scope: SpeechScope
  context: SpeechCleanupContext
}

export interface SpeechCleanupContext {
  view: 'project' | 'inbox'
  projectLabel?: string
  threadLabel?: string
  branch?: string
  glossary: string[]
}

export interface SpeechCleanupProvenance {
  mode: 'none' | 'local' | 'remote'
  runtime?: SpeechRuntime
  artifactId?: string
  modelId?: string
  appliedRuleIds: string[]
  failed: boolean
  error?: SpeechError
}

export type SpeechCorrectionRuleKind = 'vocabulary' | 'formatting'

export interface SpeechCorrectionRule {
  id: string
  kind: SpeechCorrectionRuleKind
  scope: SpeechScope
  source: string
  replacement: string
  confidence: number
  evidenceCount: number
  enabled: boolean
  createdAt: number
  updatedAt: number
  lastReinforcedAt: number
}

export interface SpeechDictationSpan {
  id: string
  attemptId: string
  editorId: string
  insertedText: string
  startOffset: number
  endOffset: number
  insertedAt: number
  scope: SpeechScope
}

export interface SpeechCorrectionObservation {
  span: SpeechDictationSpan
  sentText: string
  sentAt: number
}

export interface SpeechSegment {
  id: string
  index: number
  text: string
  kind: 'heading' | 'prose' | 'list-item' | 'link' | 'code'
}

export type SpeechPlaybackState =
  | { state: 'idle' }
  | { state: 'preparing'; sessionId: string; messageId: string }
  | { state: 'playing'; sessionId: string; messageId: string; segmentIndex: number }
  | { state: 'paused'; sessionId: string; messageId: string; segmentIndex: number }
  | { state: 'completed'; messageId: string }
  | { state: 'failed'; messageId: string; error: SpeechError }

export interface SpeechPlaybackSession {
  id: string
  messageId: string
  runtime: SpeechRuntime
  artifactId: string
  voiceId: string
  segments: SpeechSegment[]
  state: SpeechPlaybackState
  createdAt: number
}

export interface SpeechPreparedPlayback {
  sessionId: string
  messageId: string
  segments: SpeechSegment[]
}

export interface SpeechSynthesizedSegment {
  sessionId: string
  segmentIndex: number
  audio: Uint8Array<ArrayBuffer>
}

export interface SpeechCueSettings {
  listeningStarted: boolean
  recordingStopped: boolean
  transcriptReady: boolean
  volume: number
}

export interface SpeechSettings {
  runtimeOverride?: SpeechRuntime
  asrArtifactId?: string
  cleanupArtifactId?: string
  ttsArtifactId?: string
  ttsVoiceId?: string
  preferredLanguages: string[]
  localCleanupEnabled: boolean
  remoteCleanupEnabled: boolean
  remoteCleanupSelection: 'fixed' | 'conversation'
  remoteCleanupModelId?: string
  includeCodeBlocksInSpeech: boolean
  historyLimit: number
  cues: SpeechCueSettings
  keepAsrLoaded: boolean
  keepCleanupLoaded: boolean
  keepTtsLoaded: boolean
}

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  preferredLanguages: [],
  localCleanupEnabled: true,
  remoteCleanupEnabled: false,
  remoteCleanupSelection: 'conversation',
  includeCodeBlocksInSpeech: false,
  historyLimit: DEFAULT_SPEECH_HISTORY_LIMIT,
  cues: {
    listeningStarted: true,
    recordingStopped: true,
    transcriptReady: true,
    volume: 0.7
  },
  keepAsrLoaded: false,
  keepCleanupLoaded: false,
  keepTtsLoaded: false
}

export type SpeechErrorCode =
  | SpeechCompatibilityErrorCode
  | 'permission-denied'
  | 'permission-revoked'
  | 'capture-device-lost'
  | 'capture-session-stale'
  | 'invalid-request'
  | 'chunk-too-large'
  | 'queue-full'
  | 'cancelled'
  | 'insufficient-disk'
  | 'download-failed'
  | 'checksum-mismatch'
  | 'storage-failed'
  | 'backend-failed'
  | 'transcription-failed'
  | 'cleanup-failed'
  | 'synthesis-failed'
  | 'not-found'
  | 'confirmation-required'
  | 'confirmation-stale'

export interface SpeechError {
  code: SpeechErrorCode
  message: string
  retryable: boolean
  detail?: string
}

export interface SpeechHistoryPage {
  items: SpeechRecordingAttempt[]
  nextCursor?: string
  total: number
}

export type SpeechDestructiveAction =
  'history-item' | 'all-history' | 'recording' | 'rule' | 'model'

export interface SpeechConfirmation {
  token: string
  action: SpeechDestructiveAction
  targetId: string
  expiresAt: number
}

export type SpeechResult<T> = { ok: true; value: T } | { ok: false; error: SpeechError }

export interface SpeechCaptureSessionInfo {
  sessionId: string
  attemptId: string
  startedAt: number
}

export interface SpeechTranscriptionResult {
  attemptId: string
  jobId: string
  rawTranscript: string
  finalTranscript: string
}

export interface SpeechDownloadRequest {
  artifactId: string
}

export interface SpeechCapabilitySnapshot {
  target: SpeechPlatformTarget
  runtimes: SpeechRuntimeAvailability[]
  recommendedRuntime: SpeechRuntime
  selectedRuntime?: SpeechRuntime
  installedArtifacts: SpeechInstalledArtifact[]
}

export type SpeechProgressEvent =
  | { kind: 'capture'; capture: SpeechCaptureState }
  | { kind: 'download'; artifactId: string; download: SpeechDownloadState }
  | { kind: 'transcription'; job: SpeechTranscriptionJob }
  | { kind: 'playback'; playback: SpeechPlaybackState }
  | { kind: 'history'; attemptId: string; stage: SpeechAttemptStage }

export function recommendedSpeechRuntime(target: SpeechPlatformTarget): SpeechRuntime {
  return target.platform === 'darwin' && target.architecture === 'arm64' ? 'mlx' : 'sherpa-onnx'
}

export function resolveSpeechRuntime(
  target: SpeechPlatformTarget,
  availability: SpeechRuntimeAvailability[],
  override?: SpeechRuntime
): SpeechRuntimeResolutionResult {
  const runtime = override ?? recommendedSpeechRuntime(target)
  const runtimeStatus = availability.find((item) => item.runtime === runtime)
  if (!runtimeStatus?.available) {
    return {
      ok: false,
      error: {
        kind: 'compatibility-error',
        code:
          runtime === 'mlx' && target.platform !== 'darwin'
            ? 'runtime-unsupported'
            : 'runtime-unavailable',
        message:
          runtimeStatus?.reason ??
          `${runtime === 'mlx' ? 'MLX' : 'sherpa-onnx'} is not available on this device.`,
        runtime,
        target
      }
    }
  }
  return {
    ok: true,
    value: {
      runtime,
      source: override === undefined ? 'platform-default' : 'user-override',
      target
    }
  }
}
