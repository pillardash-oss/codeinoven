import { AGENT_BEHAVIOR_PROMPT_MAX_LENGTH } from '../../../lib/agent-behavior'
import {
  DEFAULT_VOICE_RECORDING_SHORTCUT,
  normalizeVoiceRecordingShortcut
} from '../../../lib/speech/types'
import { THINKING_LEVEL_ORDER } from '../../../lib/thinking-presets'
import { AUXILIARY_AGENT_ID_MAX_LENGTH, MAX_AUXILIARY_AGENTS } from '../../../lib/auxiliary-agents'
import { validateMemoryConfig } from '../../chat/memory-service'
import { validateBoundedString, validateEntityId, validateMergeMethod } from '../ipc-validation'
import { isRecord, requireString } from './shared'
import type {
  AgentDefaultsConfig,
  AgentModelSelection,
  AppConfigPatch,
  AuxiliaryAgentConfig,
  EditorId,
  HeartbeatConfig,
  LocalProfileAnalyticsRange,
  ThinkingLevel
} from '../../../lib/types'

const THEMES = new Set(['light', 'dark', 'system'])
const SLASH_COMMAND_MODES = new Set(['app', 'passthrough'])
const GIT_PULL_PREFERENCES = new Set(['ask', 'merge', 'rebase', 'ff-only'])

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
  'openLocalhostInCioBrowser',
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
  validateAgentModelSelection,
  validateHeartbeatCreateInput,
  validateHeartbeatPatchInput
}
