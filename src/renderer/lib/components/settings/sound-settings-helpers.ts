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

/** True when the artifact is the active model of the given capability. */
export function isActiveArtifact(
  settings: SpeechSettings,
  artifactId: string,
  sub: ModelSubTab
): boolean {
  return activeIdFor(settings, sub) === artifactId
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

export function runtimeBadgeClass(runtime: string): string {
  if (runtime === 'mlx') return 'bg-violet-500/15 text-violet-600 border-violet-500/20'
  if (runtime === 'sherpa-onnx') return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/20'
  if (runtime === 'gguf') return 'bg-amber-500/15 text-amber-600 border-amber-500/20'
  if (runtime === 'coreml') return 'bg-blue-500/15 text-blue-600 border-blue-500/20'
  return 'bg-muted/10 text-muted border-border'
}

export function bestForBadge(artifact: SpeechModelArtifact): { label: string; cls: string } | null {
  if (artifact.id === 'parakeet-tdt-v2-sherpa-onnx-int8')
    return { label: 'Best for English', cls: 'bg-sky-500 text-white border-sky-600' }
  if (artifact.id === 'parakeet-tdt-v3-sherpa-onnx-int8')
    return { label: 'Best for Multilingual', cls: 'bg-indigo-500 text-white border-indigo-600' }
  if (artifact.id === 'parakeet-tdt-v2-coreml')
    return { label: 'Best for English · Core ML', cls: 'bg-sky-600 text-white border-sky-700' }
  if (artifact.id === 'parakeet-tdt-v3-coreml')
    return {
      label: 'Best for Multilingual · Core ML',
      cls: 'bg-indigo-600 text-white border-indigo-700'
    }
  if (artifact.id === 'whisper-base-mlx-4bit')
    return { label: 'Apple Silicon · Fast', cls: 'bg-zinc-800 text-white border-zinc-700' }
  if (artifact.id === 'whisper-base-sherpa-int8')
    return { label: 'Portable · All platforms', cls: 'bg-white text-zinc-700 border-zinc-200' }
  if (artifact.id === 'kokoro-en-mlx-8bit')
    return { label: 'Best quality · MLX', cls: 'bg-violet-500 text-white border-violet-600' }
  if (artifact.id === 'kokoro-en-sherpa-v0-19')
    return { label: 'Portable · ONNX', cls: 'bg-white text-zinc-700 border-zinc-200' }
  if (artifact.id === 'qwen3-cleanup-mlx-0-6b-4bit')
    return { label: 'Recommended · MLX', cls: 'bg-violet-500 text-white border-violet-600' }
  if (artifact.id === 'sherpa-punctuation-zh-en')
    return { label: 'Lightweight · Portable', cls: 'bg-white text-zinc-700 border-zinc-200' }
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1_048_576).toFixed(1)} MB`
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`
}

export function downloadPercent(download: { bytesReceived: number; totalBytes: number }): number {
  if (download.totalBytes <= 0) return 0
  return Math.min(
    100,
    Math.max(0, Math.round((download.bytesReceived / download.totalBytes) * 100))
  )
}

export function isImportedForCapability(
  artifact: { capability?: SpeechCapability; runtime: SpeechRuntime },
  cap: SpeechCapability
): boolean {
  if (artifact.capability) return artifact.capability === cap
  // Fallback for legacy imports without capability: infer via runtime
  // gguf only belongs to cleanup, coreml only to asr
  if (artifact.runtime === 'gguf') return cap === 'cleanup'
  if (artifact.runtime === 'coreml') return cap === 'asr'
  // mlx/sherpa-onnx could be any, but without capability we hide to avoid leakage - only show on asr as safest fallback
  return cap === 'asr'
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
    'whisper-base-mlx-4bit': 5,
    'whisper-base-sherpa-int8': 6,
    'kokoro-en-mlx-8bit': 1,
    'kokoro-en-sherpa-v0-19': 2,
    'qwen3-cleanup-mlx-0-6b-4bit': 1,
    'sherpa-punctuation-zh-en': 2
  }
  const sorted = [...filtered].sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99))
  if (runtimeFilter !== 'all')
    return sorted.filter((artifact) => artifact.runtime === runtimeFilter)
  return sorted
}
