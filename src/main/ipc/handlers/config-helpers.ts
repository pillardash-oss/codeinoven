import { AGENT_BEHAVIOR_PROMPT_MAX_LENGTH } from '../../../lib/agent-behavior'
import {
  DEFAULT_VOICE_RECORDING_SHORTCUT,
  normalizeVoiceRecordingShortcut
} from '../../../lib/speech/types'
import { THINKING_LEVEL_ORDER } from '../../../lib/thinking-presets'
import {
  MAX_PROTOTYPE_CDN_ORIGINS,
  normalizePrototypeCdnOrigin
} from '../../../lib/prototypes/prototype-cdn'
import {
  DESIGN_ASSIGNMENT_ID_MAX_LENGTH,
  DESIGN_ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH,
  DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH,
  DESIGN_ASSIGNMENT_OUTPUTS,
  MAX_DESIGN_ASSIGNMENTS,
  designAssignmentIsMedia,
  designAssignmentOutputWork,
  isDesignAssignmentId,
  isDesignAssignmentOutput
} from '../../../lib/design-assignments'
import {
  MEDIA_PROVIDER_IDS,
  isValidMediaModel,
  isMediaProviderId
} from '../../../lib/media-generation'
import { AUXILIARY_AGENT_ID_MAX_LENGTH, MAX_AUXILIARY_AGENTS } from '../../../lib/auxiliary-agents'
import { validateMemoryConfig } from '../../chat/memory-service'
import { MAX_MAX_CONFLICT_FILE_BYTES, MIN_MAX_CONFLICT_FILE_BYTES } from '../../../lib/types'
import { validateBoundedString, validateEntityId, validateMergeMethod } from '../ipc-validation'
import { isRecord, requireString } from './shared'
import type {
  AgentDefaultsConfig,
  AgentModelSelection,
  AppConfigPatch,
  AuxiliaryAgentConfig,
  DesignAssignment,
  DesignConfig,
  EditorId,
  HeartbeatConfig,
  LocalProfileAnalyticsRange,
  LocalRankingGradeScope,
  LocalUsageClearInput,
  LocalUsageRecordStore,
  MediaGenerationConfig,
  RankingJudgeConfig,
  RankingJudgeKind,
  ThinkingLevel
} from '../../../lib/types'

const THEMES = new Set(['light', 'dark', 'system'])
const SLASH_COMMAND_MODES = new Set(['app', 'passthrough'])
const GIT_PULL_PREFERENCES = new Set(['ask', 'merge', 'rebase', 'ff-only'])
const LOCAL_USAGE_RECORD_STORES = new Set<LocalUsageRecordStore>([
  'agentResponses',
  'utilities',
  'modelRankings'
])
const RANKING_GRADE_SCOPES = new Set<LocalRankingGradeScope>(['due', 'all'])

/** Which conversations a user-requested ranking grade run covers. */
export function validateRankingGradeScope(value: unknown): LocalRankingGradeScope {
  if (typeof value !== 'string' || !RANKING_GRADE_SCOPES.has(value as LocalRankingGradeScope)) {
    throw new TypeError('Ranking grade scope is invalid')
  }
  return value as LocalRankingGradeScope
}

const EDITOR_IDS = new Set<EditorId>([
  'system',
  'terminal',
  'iterm2',
  'ghostty',
  'cmux',
  'warp',
  'kitty',
  'alacritty',
  'vscode',
  'cursor',
  'zed',
  'webstorm',
  'idea'
])
const MAX_PROFILE_ANALYTICS_RANGE_MS = 371 * 24 * 60 * 60 * 1_000

function validateLocalProfileAnalyticsRange(value: unknown): LocalProfileAnalyticsRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Profile analytics range must be an object')
  }
  const range = value as Record<string, unknown>
  const startAt = range['startAt']
  const endAt = range['endAt']
  if (
    typeof startAt !== 'number' ||
    !Number.isSafeInteger(startAt) ||
    startAt < 0 ||
    typeof endAt !== 'number' ||
    !Number.isSafeInteger(endAt) ||
    endAt <= startAt ||
    endAt - startAt > MAX_PROFILE_ANALYTICS_RANGE_MS
  ) {
    throw new TypeError('Profile analytics range is invalid')
  }
  return { startAt, endAt }
}

/**
 * Validate a Usage page clean-slate request.
 *
 * The store is checked against the closed set the page can ask for, and the
 * range reuses the same bounds the analytics read enforces, so a clear can
 * never target a wider window than the page is able to display.
 */
function validateLocalUsageClearInput(value: unknown): LocalUsageClearInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Usage clear request must be an object')
  }
  const record = value as Record<string, unknown>
  const store = record['store']
  if (
    store !== 'all' &&
    (typeof store !== 'string' || !LOCAL_USAGE_RECORD_STORES.has(store as LocalUsageRecordStore))
  ) {
    throw new TypeError('Usage clear store is invalid')
  }
  return {
    store: store as LocalUsageClearInput['store'],
    range: validateLocalProfileAnalyticsRange(record['range'])
  }
}

const CONFIG_PATCH_FIELDS = new Set([
  'theme',
  'fontFamily',
  'appFontSize',
  'fontWeight',
  'zoomLevel',
  'onboardingCompleted',
  'threadLimit',
  'questionTimeoutMs',
  'agentQuestionCap',
  'slashCommandMode',
  'preferredEditor',
  'memory',
  'agentDefaults',
  'auxiliaryAgents',
  'design',
  'mediaGeneration',
  'rankingJudge',
  'agentBehaviorPrompt',
  'autoDownloadUpdates',
  'autoInstallUpdates',
  'updateChannel',
  'keepAwakeWhileWorking',
  'imageDescriptorAskAgain',
  'autoRetryAfterReset',
  'resumeWorkOnRestart',
  'defaultMergeMethod',
  'defaultPullStrategy',
  'maxDiffLines',
  'maxConflictFileBytes',
  'openLocalhostInCioBrowser',
  'openAllLinksInCioBrowser',
  'allowPrototypeExternalCdn',
  'prototypeCdnAllowlist',
  'inAppNotificationSound',
  'sound'
])

const AGENT_DEFAULT_FIELDS = new Set([
  'seniorEngineer',
  'worker',
  'auditor',
  'imageDescriptor',
  'imageDescriptorFallback',
  'syncFromThreadChanges'
])
function isUnloadOption(value: unknown): value is '5m' | '10m' | '20m' | '30m' | 'keep' {
  return value === '5m' || value === '10m' || value === '20m' || value === '30m' || value === 'keep'
}

function validateAgentModelSelection(value: unknown, label: string): AgentModelSelection {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`)
  const fields = new Set(['harnessId', 'providerId', 'modelId', 'accountId', 'thinkingLevel'])
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`Unsupported ${label} field: ${field}`)
  }
  const thinkingLevel = value.thinkingLevel
  if (
    thinkingLevel !== undefined &&
    (typeof thinkingLevel !== 'string' ||
      !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(thinkingLevel))
  ) {
    throw new TypeError(`${label} thinking level is invalid`)
  }
  return {
    harnessId: requireString(value.harnessId, `${label} harness ID`),
    providerId: requireString(value.providerId, `${label} provider ID`),
    modelId: requireString(value.modelId, `${label} model ID`),
    ...(value.accountId === undefined
      ? {}
      : { accountId: requireString(value.accountId, `${label} account ID`) }),
    ...(thinkingLevel === undefined
      ? {}
      : { thinkingLevel: thinkingLevel as AgentModelSelection['thinkingLevel'] })
  }
}

function validateAgentDefaults(value: unknown): AgentDefaultsConfig {
  if (!isRecord(value)) throw new TypeError('Agent defaults must be an object')
  for (const field of Object.keys(value)) {
    if (!AGENT_DEFAULT_FIELDS.has(field)) {
      throw new TypeError(`Unsupported agent defaults field: ${field}`)
    }
  }
  if (typeof value.syncFromThreadChanges !== 'boolean') {
    throw new TypeError('Agent default thread synchronization must be a boolean')
  }
  return {
    syncFromThreadChanges: value.syncFromThreadChanges,
    ...(value.seniorEngineer === undefined
      ? {}
      : {
          seniorEngineer: validateAgentModelSelection(value.seniorEngineer, 'Sr. Engineer default')
        }),
    ...(value.worker === undefined
      ? {}
      : { worker: validateAgentModelSelection(value.worker, 'Worker default') }),
    ...(value.auditor === undefined
      ? {}
      : { auditor: validateAgentModelSelection(value.auditor, 'Auditor default') }),
    ...(value.imageDescriptor === undefined
      ? {}
      : {
          imageDescriptor: validateAgentModelSelection(
            value.imageDescriptor,
            'Image descriptor default'
          )
        }),
    ...(value.imageDescriptorFallback === undefined
      ? {}
      : {
          imageDescriptorFallback: validateAgentModelSelection(
            value.imageDescriptorFallback,
            'Image descriptor fallback default'
          )
        })
  }
}

/**
 * Validate the per-harness auxiliary model assignments. Keys are harness ids a
 * thread may run on; values name the harness that runs the auxiliary work, so
 * a key and its value's harness are allowed to differ (a Pi local model can
 * serve every harness).
 */
export function validateAuxiliaryAgents(value: unknown): AuxiliaryAgentConfig {
  if (!isRecord(value)) throw new TypeError('Auxiliary agents must be an object')
  const entries = Object.entries(value)
  if (entries.length > MAX_AUXILIARY_AGENTS) {
    throw new TypeError(`Auxiliary agents accept at most ${MAX_AUXILIARY_AGENTS} harnesses`)
  }
  const auxiliaryAgents: AuxiliaryAgentConfig = {}
  for (const [harnessId, selection] of entries) {
    if (!harnessId.trim() || harnessId.length > AUXILIARY_AGENT_ID_MAX_LENGTH) {
      throw new TypeError(`Auxiliary agent harness ID is invalid: ${harnessId}`)
    }
    auxiliaryAgents[harnessId] = validateAgentModelSelection(
      selection,
      `Auxiliary agent for ${harnessId}`
    )
  }
  return auxiliaryAgents
}

/** Fields one design assignment may carry, and no others. */
const DESIGN_ASSIGNMENT_FIELDS = new Set([
  'id',
  'label',
  'produces',
  'instructions',
  'selection',
  'mediaModel'
])

/**
 * Validate the user's design assignments.
 *
 * Every row must name the model that does the work: an assignment without a
 * complete harness, provider and model would be routed somewhere the user never
 * chose, so it is rejected at the boundary instead of being stored inert.
 * Ids are unique because an agent resolves an assignment by id, and two rows
 * sharing one would make the call ambiguous.
 */
function validateDesignConfig(value: unknown): DesignConfig {
  if (!isRecord(value)) throw new TypeError('Design settings must be an object')
  for (const field of Object.keys(value)) {
    if (field !== 'assignments') throw new TypeError(`Unsupported design settings field: ${field}`)
  }
  const assignments = value.assignments
  if (!Array.isArray(assignments)) {
    throw new TypeError('Design assignments must be an array')
  }
  if (assignments.length > MAX_DESIGN_ASSIGNMENTS) {
    throw new TypeError(`Design assignments accept at most ${MAX_DESIGN_ASSIGNMENTS} rows`)
  }
  const seen = new Set<string>()
  const validated: DesignAssignment[] = assignments.map((entry: unknown, index: number) => {
    const label = `Design assignment ${index + 1}`
    if (!isRecord(entry)) throw new TypeError(`${label} must be an object`)
    for (const field of Object.keys(entry)) {
      if (!DESIGN_ASSIGNMENT_FIELDS.has(field)) {
        throw new TypeError(`Unsupported ${label} field: ${field}`)
      }
    }
    const id = requireString(entry.id, `${label} ID`)
    if (id.length > DESIGN_ASSIGNMENT_ID_MAX_LENGTH || !isDesignAssignmentId(id)) {
      throw new TypeError(`${label} ID must be a short lowercase handle like "image-generation"`)
    }
    if (seen.has(id)) throw new TypeError(`Design assignments repeat the ID "${id}"`)
    seen.add(id)
    const name = requireString(entry.label, `${label} name`)
    if (name.length > DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH) {
      throw new TypeError(`${label} name is too long`)
    }
    const instructions = entry.instructions
    if (
      instructions !== undefined &&
      (typeof instructions !== 'string' ||
        instructions.length > DESIGN_ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH)
    ) {
      throw new TypeError(`${label} guidance is too long`)
    }
    const produces = entry.produces
    if (produces !== undefined && !isDesignAssignmentOutput(produces)) {
      throw new TypeError(`${label} output must be one of ${DESIGN_ASSIGNMENT_OUTPUTS.join(', ')}`)
    }
    const output = produces ?? 'text'
    const common = {
      id,
      label: name,
      // Copywriting is the default and the only output a config written before
      // this field existed could mean, so storing it would add a word to every
      // row.
      ...(produces === undefined || produces === 'text' ? {} : { produces }),
      ...(instructions === undefined || instructions.trim().length === 0 ? {} : { instructions })
    }
    // A craft's model comes from the place that can actually run it: a media
    // craft names a generation model, a text craft a harness model. Requiring
    // the wrong one would store a row that can never run.
    if (designAssignmentIsMedia(output)) {
      if (!isValidMediaModel(entry.mediaModel)) {
        throw new TypeError(
          `${label} needs a generation model like "owner/name" for ${designAssignmentOutputWork(output)}`
        )
      }
      return { ...common, mediaModel: entry.mediaModel.trim() }
    }
    return { ...common, selection: validateAgentModelSelection(entry.selection, `${label} model`) }
  })
  return { assignments: validated }
}

/**
 * Validate the generation backend choice.
 *
 * Only the provider id is configurable: the token lives in the secure vault and
 * the model for each craft is the user's design assignment, so there is nothing
 * else here that could point the app at a service the user did not choose.
 */
function validateMediaGenerationConfig(value: unknown): MediaGenerationConfig {
  if (!isRecord(value)) throw new TypeError('Generation settings must be an object')
  for (const field of Object.keys(value)) {
    if (field !== 'providerId') {
      throw new TypeError(`Unsupported generation settings field: ${field}`)
    }
  }
  const providerId = value.providerId
  if (providerId === undefined || providerId === null) return { providerId: null }
  if (!isMediaProviderId(providerId)) {
    throw new TypeError(`Generation provider must be one of ${MEDIA_PROVIDER_IDS.join(', ')}`)
  }
  return { providerId }
}

const RANKING_JUDGE_KINDS = new Set<RankingJudgeKind>(['automatic', 'typesafe', 'model'])
const RANKING_JUDGE_MODEL_FIELDS = [
  'harnessId',
  'providerId',
  'modelId',
  'accountId',
  'thinkingLevel'
] as const

/**
 * The ranking-judge preference.
 *
 * A `model` pin must name a complete selection, because a half-written pin would
 * silently grade with the automatic chain while the settings page claimed
 * otherwise. The other kinds must carry no model fields at all: a stale pin that
 * survives a switch back to the automatic chain is exactly the quiet
 * contradiction this boundary exists to refuse.
 */
export function validateRankingJudge(value: unknown): RankingJudgeConfig {
  if (!isRecord(value)) throw new TypeError('Ranking judge must be an object')
  const fields = new Set<string>(['kind', ...RANKING_JUDGE_MODEL_FIELDS])
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new TypeError(`Unsupported ranking judge field: ${field}`)
  }
  const kind = value.kind
  if (typeof kind !== 'string' || !RANKING_JUDGE_KINDS.has(kind as RankingJudgeKind)) {
    throw new TypeError('Ranking judge kind is invalid')
  }
  if (kind !== 'model') {
    for (const field of RANKING_JUDGE_MODEL_FIELDS) {
      if (field in value) {
        throw new TypeError(`Ranking judge ${field} is only valid for a model pin`)
      }
    }
    return { kind: kind as RankingJudgeKind }
  }
  // The kind is this preference's own discriminator, so it is removed before
  // the rest is validated as a model selection, which rejects unknown fields.
  const selection: Record<string, unknown> = { ...value }
  delete selection['kind']
  return { kind: 'model', ...validateAgentModelSelection(selection, 'Ranking judge') }
}

const FONT_FAMILIES = new Set([
  'jetbrains-mono',
  'satoshi',
  'system',
  'sf-mono',
  'menlo',
  'monaco',
  'fira-code'
])

/** Validate the complete renderer-controlled config boundary. */
export function validateAppConfigPatch(value: unknown): AppConfigPatch {
  if (!isRecord(value)) throw new TypeError('Config patch must be an object')

  for (const field of Object.keys(value)) {
    if (!CONFIG_PATCH_FIELDS.has(field)) {
      throw new TypeError(`Unsupported config field: ${field}`)
    }
  }

  const patch: AppConfigPatch = {}

  if ('theme' in value) {
    if (typeof value.theme !== 'string' || !THEMES.has(value.theme)) {
      throw new TypeError('Invalid theme')
    }
    patch.theme = value.theme as AppConfigPatch['theme']
  }

  if ('fontFamily' in value) {
    if (typeof value.fontFamily !== 'string' || !FONT_FAMILIES.has(value.fontFamily)) {
      throw new TypeError('Invalid font family')
    }
    patch.fontFamily = value.fontFamily
  }

  if ('appFontSize' in value) {
    if (
      typeof value.appFontSize !== 'number' ||
      !Number.isInteger(value.appFontSize) ||
      value.appFontSize < 12 ||
      value.appFontSize > 18
    ) {
      throw new TypeError('App font size must be an integer between 12 and 18')
    }
    patch.appFontSize = value.appFontSize
  }

  if ('fontWeight' in value) {
    if (
      typeof value.fontWeight !== 'number' ||
      !Number.isInteger(value.fontWeight) ||
      value.fontWeight < 100 ||
      value.fontWeight > 800 ||
      value.fontWeight % 100 !== 0
    ) {
      throw new TypeError('Font weight must be a multiple of 100 between 100 and 800')
    }
    patch.fontWeight = value.fontWeight
  }

  if ('zoomLevel' in value) {
    if (
      typeof value.zoomLevel !== 'number' ||
      !Number.isFinite(value.zoomLevel) ||
      value.zoomLevel < 0.5 ||
      value.zoomLevel > 2
    ) {
      throw new TypeError('Zoom level must be between 0.5 and 2')
    }
    patch.zoomLevel = value.zoomLevel
  }

  if ('onboardingCompleted' in value) {
    if (typeof value.onboardingCompleted !== 'boolean') {
      throw new TypeError('onboardingCompleted must be a boolean')
    }
    patch.onboardingCompleted = value.onboardingCompleted
  }

  if ('threadLimit' in value) {
    if (
      typeof value.threadLimit !== 'number' ||
      !Number.isInteger(value.threadLimit) ||
      value.threadLimit < 1 ||
      value.threadLimit > 1000
    ) {
      throw new TypeError('Thread limit must be an integer between 1 and 1000')
    }
    patch.threadLimit = value.threadLimit
  }

  if ('questionTimeoutMs' in value) {
    if (
      typeof value.questionTimeoutMs !== 'number' ||
      !Number.isSafeInteger(value.questionTimeoutMs) ||
      value.questionTimeoutMs < 10_000 ||
      value.questionTimeoutMs > 3_600_000
    ) {
      throw new TypeError(
        'Question timeout must be an integer between 10000 and 3600000 milliseconds'
      )
    }
    patch.questionTimeoutMs = value.questionTimeoutMs
  }

  if ('agentQuestionCap' in value) {
    if (
      typeof value.agentQuestionCap !== 'number' ||
      !Number.isInteger(value.agentQuestionCap) ||
      value.agentQuestionCap < 1 ||
      value.agentQuestionCap > 10
    ) {
      throw new TypeError('Agent question cap must be an integer between 1 and 10')
    }
    patch.agentQuestionCap = value.agentQuestionCap
  }

  if ('maxDiffLines' in value) {
    if (
      typeof value.maxDiffLines !== 'number' ||
      !Number.isInteger(value.maxDiffLines) ||
      value.maxDiffLines < 10 ||
      value.maxDiffLines > 5000
    ) {
      throw new TypeError('Max diff lines must be an integer between 10 and 5000')
    }
    patch.maxDiffLines = value.maxDiffLines
  }

  if ('maxConflictFileBytes' in value) {
    if (
      typeof value.maxConflictFileBytes !== 'number' ||
      !Number.isInteger(value.maxConflictFileBytes) ||
      value.maxConflictFileBytes < MIN_MAX_CONFLICT_FILE_BYTES ||
      value.maxConflictFileBytes > MAX_MAX_CONFLICT_FILE_BYTES
    ) {
      throw new TypeError(
        `Merge editor file limit must be an integer between ${MIN_MAX_CONFLICT_FILE_BYTES} and ${MAX_MAX_CONFLICT_FILE_BYTES} bytes`
      )
    }
    patch.maxConflictFileBytes = value.maxConflictFileBytes
  }

  if ('defaultPullStrategy' in value) {
    if (
      typeof value.defaultPullStrategy !== 'string' ||
      !GIT_PULL_PREFERENCES.has(value.defaultPullStrategy)
    ) {
      throw new TypeError('Invalid default pull strategy')
    }
    patch.defaultPullStrategy = value.defaultPullStrategy as AppConfigPatch['defaultPullStrategy']
  }

  if ('openLocalhostInCioBrowser' in value) {
    if (typeof value.openLocalhostInCioBrowser !== 'boolean') {
      throw new TypeError('Open localhost in CIO browser must be a boolean')
    }
    patch.openLocalhostInCioBrowser = value.openLocalhostInCioBrowser
  }

  if ('openAllLinksInCioBrowser' in value) {
    if (typeof value.openAllLinksInCioBrowser !== 'boolean') {
      throw new TypeError('Open all links in CIO browser must be a boolean')
    }
    patch.openAllLinksInCioBrowser = value.openAllLinksInCioBrowser
  }

  if ('allowPrototypeExternalCdn' in value) {
    if (typeof value.allowPrototypeExternalCdn !== 'boolean') {
      throw new TypeError('Prototype external CDN must be a boolean')
    }
    patch.allowPrototypeExternalCdn = value.allowPrototypeExternalCdn
  }

  if ('prototypeCdnAllowlist' in value) {
    const allowlist = value.prototypeCdnAllowlist
    if (!Array.isArray(allowlist)) {
      throw new TypeError('Prototype CDN allowlist must be an array')
    }
    if (allowlist.length > MAX_PROTOTYPE_CDN_ORIGINS) {
      throw new TypeError(
        `Prototype CDN allowlist accepts at most ${MAX_PROTOTYPE_CDN_ORIGINS} origins`
      )
    }
    // Stored normalized and deduplicated, so a rejected spelling never reaches
    // the config file and the same origin cannot be approved twice.
    const origins: string[] = []
    for (const entry of allowlist) {
      if (typeof entry !== 'string') {
        throw new TypeError('Prototype CDN origins must be strings')
      }
      const origin = normalizePrototypeCdnOrigin(entry)
      if (!origin) {
        throw new TypeError(`Not a usable HTTPS CDN origin: ${entry.trim()}`)
      }
      if (!origins.includes(origin)) origins.push(origin)
    }
    patch.prototypeCdnAllowlist = origins
  }

  if ('inAppNotificationSound' in value) {
    const sound = value.inAppNotificationSound
    if (!isRecord(sound)) throw new TypeError('In-app notification sound must be an object')
    for (const field of Object.keys(sound)) {
      if (field !== 'success' && field !== 'issue') {
        throw new TypeError(`Unsupported in-app notification sound field: ${field}`)
      }
    }
    if (typeof sound.success !== 'boolean' || typeof sound.issue !== 'boolean') {
      throw new TypeError('In-app notification sound toggles must be booleans')
    }
    patch.inAppNotificationSound = { success: sound.success, issue: sound.issue }
  }

  if ('sound' in value) {
    if (!isRecord(value.sound)) throw new TypeError('Sound settings must be an object')
    const sound = value.sound
    if (
      typeof sound.localCleanupEnabled !== 'boolean' ||
      typeof sound.remoteCleanupEnabled !== 'boolean' ||
      (sound.remoteCleanupSelection !== 'fixed' &&
        sound.remoteCleanupSelection !== 'conversation') ||
      typeof sound.includeCodeBlocksInSpeech !== 'boolean' ||
      !Array.isArray(sound.preferredLanguages) ||
      !sound.preferredLanguages.every(
        (language) => typeof language === 'string' && language.length <= 32
      ) ||
      typeof sound.voiceRecordingEnabled !== 'boolean' ||
      !isRecord(sound.refinementFlags) ||
      typeof sound.refinementFlags.smartCleanup !== 'boolean' ||
      typeof sound.refinementFlags.selfCorrection !== 'boolean' ||
      typeof sound.refinementFlags.preserveTechnical !== 'boolean' ||
      !isUnloadOption(sound.asrUnload) ||
      !isUnloadOption(sound.cleanupUnload) ||
      !isUnloadOption(sound.ttsUnload) ||
      !Number.isSafeInteger(sound.historyLimit) ||
      Number(sound.historyLimit) < 1 ||
      Number(sound.historyLimit) > 500 ||
      !isRecord(sound.cues) ||
      typeof sound.cues.listeningStarted !== 'boolean' ||
      typeof sound.cues.recordingStopped !== 'boolean' ||
      typeof sound.cues.transcriptReady !== 'boolean' ||
      typeof sound.cues.volume !== 'number' ||
      sound.cues.volume < 0 ||
      sound.cues.volume > 1
    ) {
      throw new TypeError('Sound settings are invalid')
    }
    const voiceRecordingShortcut =
      sound.voiceRecordingShortcut === undefined
        ? DEFAULT_VOICE_RECORDING_SHORTCUT
        : normalizeVoiceRecordingShortcut(sound.voiceRecordingShortcut)
    if (voiceRecordingShortcut === null) {
      throw new TypeError('Sound voice recording shortcut is invalid')
    }
    const optionalId = (field: string): string | undefined => {
      const candidate = sound[field]
      if (candidate === undefined) return undefined
      if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) {
        throw new TypeError(`Sound ${field} is invalid`)
      }
      return candidate
    }
    patch.sound = {
      asrArtifactId: optionalId('asrArtifactId'),
      cleanupArtifactId: optionalId('cleanupArtifactId'),
      ttsArtifactId: optionalId('ttsArtifactId'),
      ttsVoiceId: optionalId('ttsVoiceId'),
      preferredLanguages: sound.preferredLanguages,
      localCleanupEnabled: sound.localCleanupEnabled,
      refinementFlags: {
        smartCleanup: sound.refinementFlags.smartCleanup,
        selfCorrection: sound.refinementFlags.selfCorrection,
        preserveTechnical: sound.refinementFlags.preserveTechnical
      },
      remoteCleanupEnabled: sound.remoteCleanupEnabled,
      remoteCleanupSelection: sound.remoteCleanupSelection,
      remoteCleanupModelId: optionalId('remoteCleanupModelId'),
      includeCodeBlocksInSpeech: sound.includeCodeBlocksInSpeech,
      historyLimit: Number(sound.historyLimit),
      cues: {
        listeningStarted: sound.cues.listeningStarted,
        recordingStopped: sound.cues.recordingStopped,
        transcriptReady: sound.cues.transcriptReady,
        volume: sound.cues.volume
      },
      voiceRecordingEnabled: sound.voiceRecordingEnabled,
      voiceRecordingShortcut,
      asrUnload: sound.asrUnload,
      cleanupUnload: sound.cleanupUnload,
      ttsUnload: sound.ttsUnload
    }
  }

  if ('slashCommandMode' in value) {
    if (
      typeof value.slashCommandMode !== 'string' ||
      !SLASH_COMMAND_MODES.has(value.slashCommandMode)
    ) {
      throw new TypeError('Invalid slash command mode')
    }
    patch.slashCommandMode = value.slashCommandMode as AppConfigPatch['slashCommandMode']
  }

  if ('preferredEditor' in value) {
    if (
      typeof value.preferredEditor !== 'string' ||
      !EDITOR_IDS.has(value.preferredEditor as EditorId)
    ) {
      throw new TypeError('Invalid preferred editor')
    }
    patch.preferredEditor = value.preferredEditor as EditorId
  }

  if ('memory' in value) {
    patch.memory = validateMemoryConfig(value.memory)
  }

  if ('agentDefaults' in value) {
    patch.agentDefaults = validateAgentDefaults(value.agentDefaults)
  }

  if ('auxiliaryAgents' in value) {
    patch.auxiliaryAgents = validateAuxiliaryAgents(value.auxiliaryAgents)
  }

  if ('design' in value) {
    patch.design = validateDesignConfig(value.design)
  }

  if ('mediaGeneration' in value) {
    patch.mediaGeneration = validateMediaGenerationConfig(value.mediaGeneration)
  }

  if ('rankingJudge' in value) {
    patch.rankingJudge = validateRankingJudge(value.rankingJudge)
  }

  if ('agentBehaviorPrompt' in value) {
    patch.agentBehaviorPrompt = validateBoundedString(
      value.agentBehaviorPrompt,
      'Agent behavior prompt',
      1,
      AGENT_BEHAVIOR_PROMPT_MAX_LENGTH
    )
  }

  if ('autoDownloadUpdates' in value) {
    if (typeof value.autoDownloadUpdates !== 'boolean') {
      throw new TypeError('autoDownloadUpdates must be a boolean')
    }
    patch.autoDownloadUpdates = value.autoDownloadUpdates
  }

  if ('autoInstallUpdates' in value) {
    if (typeof value.autoInstallUpdates !== 'boolean') {
      throw new TypeError('autoInstallUpdates must be a boolean')
    }
    patch.autoInstallUpdates = value.autoInstallUpdates
  }

  if ('updateChannel' in value) {
    if (value.updateChannel !== 'stable' && value.updateChannel !== 'nightly') {
      throw new TypeError('updateChannel must be either "stable" or "nightly"')
    }
    patch.updateChannel = value.updateChannel
  }

  if ('keepAwakeWhileWorking' in value) {
    if (typeof value.keepAwakeWhileWorking !== 'boolean') {
      throw new TypeError('keepAwakeWhileWorking must be a boolean')
    }
    patch.keepAwakeWhileWorking = value.keepAwakeWhileWorking
  }

  if ('imageDescriptorAskAgain' in value) {
    if (typeof value.imageDescriptorAskAgain !== 'boolean') {
      throw new TypeError('imageDescriptorAskAgain must be a boolean')
    }
    patch.imageDescriptorAskAgain = value.imageDescriptorAskAgain
  }

  if ('autoRetryAfterReset' in value) {
    if (typeof value.autoRetryAfterReset !== 'boolean') {
      throw new TypeError('autoRetryAfterReset must be a boolean')
    }
    patch.autoRetryAfterReset = value.autoRetryAfterReset
  }

  if ('resumeWorkOnRestart' in value) {
    if (typeof value.resumeWorkOnRestart !== 'boolean') {
      throw new TypeError('resumeWorkOnRestart must be a boolean')
    }
    patch.resumeWorkOnRestart = value.resumeWorkOnRestart
  }

  if ('defaultMergeMethod' in value) {
    patch.defaultMergeMethod = validateMergeMethod(value.defaultMergeMethod)
  }

  return patch
}

const HEARTBEAT_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function validateHeartbeatTimes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('Heartbeat must have at least one scheduled time')
  }
  const times = value.map((entry) => {
    if (typeof entry !== 'string' || !HEARTBEAT_TIME_PATTERN.test(entry)) {
      throw new TypeError('Heartbeat times must be 24h HH:mm strings')
    }
    return entry
  })
  return [...new Set(times)]
}

/**
 * Heartbeat thinking levels are optional   not every model supports thinking.
 * Absent, null, or unrecognized levels (including driver-specific preset ids
 * outside the standard set) simply omit the level instead of failing the save;
 * the driver then applies its own default for the selected model.
 */
function validateHeartbeatThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || !THINKING_LEVEL_ORDER.includes(value as ThinkingLevel)) {
    return undefined
  }
  return value as ThinkingLevel
}

function validateHeartbeatCreateInput(value: unknown): Omit<HeartbeatConfig, 'id' | 'lastRun'> {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid heartbeat input')
  const input = value as Record<string, unknown>
  return {
    name: validateBoundedString(input.name, 'Heartbeat name', 1, 100),
    harnessId: validateBoundedString(input.harnessId, 'Heartbeat harness ID', 1, 100),
    providerId: validateBoundedString(input.providerId, 'Heartbeat provider ID', 1, 100),
    modelId: validateBoundedString(input.modelId, 'Heartbeat model ID', 1, 200),
    ...(input.accountId === undefined
      ? {}
      : { accountId: validateEntityId(input.accountId, 'Heartbeat account ID', 256) }),
    thinkingLevel: validateHeartbeatThinkingLevel(input.thinkingLevel),
    times: validateHeartbeatTimes(input.times),
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true
  }
}

function validateHeartbeatPatchInput(value: unknown): Partial<Omit<HeartbeatConfig, 'id'>> {
  if (typeof value !== 'object' || value === null) throw new TypeError('Invalid heartbeat patch')
  const input = value as Record<string, unknown>
  const patch: Partial<Omit<HeartbeatConfig, 'id'>> = {}
  if (input.name !== undefined)
    patch.name = validateBoundedString(input.name, 'Heartbeat name', 1, 100)
  if (input.harnessId !== undefined) {
    patch.harnessId = validateBoundedString(input.harnessId, 'Heartbeat harness ID', 1, 100)
  }
  if (input.providerId !== undefined) {
    patch.providerId = validateBoundedString(input.providerId, 'Heartbeat provider ID', 1, 100)
  }
  if (input.modelId !== undefined) {
    patch.modelId = validateBoundedString(input.modelId, 'Heartbeat model ID', 1, 200)
  }
  if (input.accountId !== undefined) {
    patch.accountId = validateEntityId(input.accountId, 'Heartbeat account ID', 256)
  }
  if (input.thinkingLevel !== undefined) {
    patch.thinkingLevel = validateHeartbeatThinkingLevel(input.thinkingLevel)
  }
  if (input.times !== undefined) patch.times = validateHeartbeatTimes(input.times)
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean')
      throw new TypeError('Heartbeat enabled flag must be a boolean')
    patch.enabled = input.enabled
  }
  return patch
}

export {
  EDITOR_IDS,
  validateLocalProfileAnalyticsRange,
  validateLocalUsageClearInput,
  validateAgentModelSelection,
  validateHeartbeatCreateInput,
  validateHeartbeatPatchInput
}
