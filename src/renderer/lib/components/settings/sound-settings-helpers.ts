import { posixBasename } from '$shared/paths'
import { parseModelIdentityFromPath } from '../../../../lib/speech/model-path-validation'
import type {
  SpeechCapability,
  SpeechDestructiveAction,
  SpeechInstalledArtifact,
  SpeechModelArtifact,
  SpeechRuntime,
  SpeechSettings,
  SpeechUnloadOption
} from '../../../../lib/speech/types'

export type SoundTab = 'models' | 'history' | 'learning' | 'preferences' | 'playground'
export type ModelSubTab = 'asr' | 'tts' | 'llm'

export interface PendingDeletion {
  action: SpeechDestructiveAction
  targetId: string
  label: string
  isImported?: boolean
}

export const soundTabs: ReadonlyArray<{ id: SoundTab; label: string }> = [
  { id: 'models', label: 'Models' },
  { id: 'history', label: 'History' },
  { id: 'learning', label: 'Learning' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'playground', label: 'Playground' }
]

export const modelSubTabs: ReadonlyArray<{ id: ModelSubTab; label: string; hint: string }> = [
  { id: 'asr', label: 'ASR', hint: 'Speech-to-text' },
  { id: 'tts', label: 'TTS', hint: 'Speech synthesis' },
  { id: 'llm', label: 'LLM', hint: 'Cleanup models' }
]

export const unloadItems = [
  { key: 'asrUnload', label: 'Speech-to-text (ASR)' },
  { key: 'cleanupUnload', label: 'Cleanup LLM' },
  { key: 'ttsUnload', label: 'Text-to-speech (TTS)' }
] as const satisfies ReadonlyArray<{
  key: keyof Pick<SpeechSettings, 'asrUnload' | 'cleanupUnload' | 'ttsUnload'>
  label: string
}>

export const unloadOptions = [
  { value: '5m', label: '5 minutes' },
  { value: '10m', label: '10 minutes' },
  { value: '20m', label: '20 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: 'keep', label: 'Never unload' }
] as const satisfies ReadonlyArray<{ value: SpeechUnloadOption; label: string }>

export function activeIdFor(settings: SpeechSettings, sub: ModelSubTab): string | undefined {
  if (sub === 'asr') return settings.asrArtifactId
  if (sub === 'tts') return settings.ttsArtifactId
  return settings.cleanupArtifactId
}

/** The model sub-tab a capability belongs to. */
export function modelSubTabForCapability(capability: SpeechCapability): ModelSubTab {
  if (capability === 'asr') return 'asr'
  if (capability === 'tts') return 'tts'
  return 'llm'
}

/** The persisted active artifact id for a capability. */
export function activeIdForCapability(
  settings: SpeechSettings,
  capability: SpeechCapability
): string | undefined {
  return activeIdFor(settings, modelSubTabForCapability(capability))
}

/** True when the artifact is the active model of the given capability. */
export function isActiveCapability(
  settings: SpeechSettings,
  artifactId: string,
  capability: SpeechCapability
): boolean {
  return activeIdForCapability(settings, capability) === artifactId
}

export function labelForInstalled(
  artifacts: SpeechModelArtifact[] | undefined,
  installedArtifacts: SpeechInstalledArtifact[] | undefined,
  artifactId: string
): string {
  const artifact = artifacts?.find((item) => item.id === artifactId)
  if (artifact) return artifact.label
  const imported = installedArtifacts?.find((item) => item.artifactId === artifactId)
  if (imported?.importPath) {
    const parsed = parseModelIdentityFromPath(imported.importPath, imported.runtime)
    if (parsed) return parsed.displayName
    return posixBasename(imported.importPath) || artifactId
  }
  return artifactId
}

export function runtimeBadge(runtime: string): string {
  if (runtime === 'mlx') return 'MLX'
  if (runtime === 'sherpa-onnx') return 'ONNX'
  if (runtime === 'gguf') return 'GGUF'
  if (runtime === 'coreml') return 'Core ML'
  return runtime.toUpperCase()
}

/**
 * Byte counts moved to `$lib/format/bytes` so every surface that reports a size
 * shares one implementation. Re-exported here because the sound settings tab
 * imports it from this module.
 */
export { formatBytes } from '$lib/format/bytes'
export function downloadPercent(download: { bytesReceived: number; totalBytes: number }): number {
  if (download.totalBytes <= 0) return 0
  return Math.min(
    100,
    Math.max(0, Math.round((download.bytesReceived / download.totalBytes) * 100))
  )
}

/**
 * Read the capability out of an artifact id.
 *
 * Artifact ids are a stable `<family>-<capability>-...` contract, so a model the
 * catalog has since dropped still presents in the right tab. Returns null when
 * the id carries no recognisable capability, so a row is never *guessed* into a
 * tab it may not belong to.
 */
export function capabilityFromArtifactId(artifactId: string): SpeechCapability | null {
  const tokens = new Set(artifactId.toLowerCase().split('-'))
  if (
    tokens.has('cleanup') ||
    tokens.has('normalizer') ||
    tokens.has('punctuation') ||
    tokens.has('qwen') ||
    tokens.has('s1')
  ) {
    return 'cleanup'
  }
  if (tokens.has('tts') || tokens.has('kokoro')) return 'tts'
  if (tokens.has('asr') || tokens.has('whisper') || tokens.has('parakeet')) return 'asr'
  return null
}

/**
 * The capability an installed artifact serves, or null when it cannot be
 * established.
 *
 * The catalog is the authority: a downloaded model is identified by its catalog
 * entry. An imported model carries the capability it was imported for. A row
 * with neither (a download from a catalog that has since dropped the model) is
 * read from its id, and only then from an unambiguous runtime: `gguf` is
 * cleanup-only and `coreml` is ASR-only, while `mlx` and `sherpa-onnx` serve
 * several capabilities and are therefore never guessed.
 */
export function installedCapability(
  installed: { artifactId?: string; capability?: SpeechCapability; runtime: SpeechRuntime },
  catalogArtifacts: SpeechModelArtifact[]
): SpeechCapability | null {
  const catalog =
    installed.artifactId !== undefined
      ? catalogArtifacts.find((artifact) => artifact.id === installed.artifactId)
      : undefined
  if (catalog) return catalog.capability
  if (installed.capability) return installed.capability
  const fromId = installed.artifactId ? capabilityFromArtifactId(installed.artifactId) : null
  if (fromId) return fromId
  if (installed.runtime === 'gguf') return 'cleanup'
  if (installed.runtime === 'coreml') return 'asr'
  return null
}

export function runtimesForSubTab(sub: ModelSubTab): SpeechRuntime[] {
  if (sub === 'asr') return ['mlx', 'sherpa-onnx', 'coreml']
  if (sub === 'tts') return ['mlx', 'sherpa-onnx']
  return ['mlx', 'sherpa-onnx', 'gguf']
}

export function sortedForSubTab(
  artifacts: SpeechModelArtifact[],
  sub: ModelSubTab,
  runtimeFilter: 'all' | SpeechRuntime
): SpeechModelArtifact[] {
  let filtered: SpeechModelArtifact[]
  if (sub === 'asr') filtered = artifacts.filter((artifact) => artifact.capability === 'asr')
  else if (sub === 'tts') filtered = artifacts.filter((artifact) => artifact.capability === 'tts')
  else filtered = artifacts.filter((artifact) => artifact.capability === 'cleanup')
  const order: Record<string, number> = {
    'parakeet-tdt-v2-sherpa-onnx-int8': 1,
    'parakeet-tdt-v3-sherpa-onnx-int8': 2,
    'parakeet-tdt-v2-coreml': 3,
    'parakeet-tdt-v3-coreml': 4,
    'fluid-speech-mini-coreml': 5,
    'whisper-base-mlx-4bit': 6,
    'whisper-base-sherpa-int8': 7,
    'kokoro-en-mlx-8bit': 1,
    'kokoro-en-sherpa-v0-19': 2,
    'qwen3-cleanup-gguf-0-6b': 1,
    's1-mini-cleanup-gguf-q4': 2,
    'qwen3-cleanup-gguf-1-7b': 3,
    'sherpa-punctuation-zh-en': 4
  }
  const sorted = [...filtered].sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99))
  if (runtimeFilter !== 'all')
    return sorted.filter((artifact) => artifact.runtime === runtimeFilter)
  return sorted
}
