import type { SpeechCapability, SpeechRuntime } from './types'

export interface NormalizedPath {
  normalized: string
  wasNormalized: boolean
}

/**
 * Shared paste-path normalization used by both picker and paste flows.
 * Trims surrounding whitespace and a single layer of matching outer quotes
 * (single or double) that often appear when copying from terminals.
 * Shows guidance when normalization changes the path.
 */
export function normalizePastedPath(raw: string): NormalizedPath {
  const trimmed = raw.trim()
  let normalized = trimmed
  let wasNormalized = trimmed !== raw

  if (normalized.length >= 2) {
    const first = normalized[0]
    const last = normalized[normalized.length - 1]
    const matchingQuote =
      (first === '"' && last === '"') || (first === "'" && last === "'")
    if (matchingQuote) {
      const inner = normalized.slice(1, -1).trim()
      if (inner.length > 0) {
        normalized = inner
        wasNormalized = true
      }
    }
  }

  // Collapse interior whitespace trimming already done; path separators are preserved as-is
  // per-platform (no case folding here; caller lowercases for extension checks).
  if (normalized !== raw) wasNormalized = true
  return { normalized, wasNormalized }
}

export const SUPPORTED_MODEL_EXTENSIONS = ['.mlx', '.gguf', '.onnx', '.mlmodelc', '.mlpackage'] as const

export const CAPABILITY_RUNTIMES: Record<SpeechCapability, SpeechRuntime[]> = {
  asr: ['mlx', 'sherpa-onnx', 'coreml'],
  tts: ['mlx', 'sherpa-onnx'],
  cleanup: ['mlx', 'sherpa-onnx', 'gguf']
}

export function runtimesForCapability(capability: SpeechCapability): SpeechRuntime[] {
  return CAPABILITY_RUNTIMES[capability] ?? []
}

export function describeSupportedFormats(): string {
  return 'Supported formats: .mlx directory/file (Apple Silicon) or .gguf file / folder containing .gguf.'
}

export function describeSupportedFormatsForCapability(capability: SpeechCapability): string {
  if (capability === 'asr') {
    return 'ASR: .mlx directory (Apple Silicon), sherpa-onnx folder containing .onnx + tokens.txt, or Core ML bundle (.mlmodelc / .mlpackage / folder containing .mlmodelc).'
  }
  if (capability === 'tts') {
    return 'TTS: .mlx directory (Apple Silicon) or sherpa-onnx folder containing .onnx.'
  }
  return 'LLM / Cleanup: .mlx directory (Apple Silicon), sherpa-onnx punctuation folder, or .gguf file / folder containing .gguf.'
}

export function inferRuntimeFromExtension(normalizedPath: string): SpeechRuntime | null {
  const lower = normalizedPath.toLowerCase()
  if (
    lower.endsWith('.mlx') ||
    lower.endsWith('/.mlx') ||
    lower.endsWith('\\mlx')
  ) {
    return 'mlx'
  }
  if (lower.endsWith('.gguf')) return 'gguf'
  if (lower.endsWith('.mlmodelc') || lower.endsWith('.mlpackage')) return 'coreml'
  if (lower.endsWith('.onnx')) return 'sherpa-onnx'
  return null
}

export function inferRuntimeForCapability(
  normalizedPath: string,
  capability: SpeechCapability
): SpeechRuntime | null {
  const runtime = inferRuntimeFromExtension(normalizedPath)
  if (!runtime) return null
  const allowed = runtimesForCapability(capability)
  return allowed.includes(runtime) ? runtime : null
}

export function extensionForDisplay(normalizedPath: string): string | undefined {
  const lower = normalizedPath.toLowerCase()
  if (lower.endsWith('.mlx') || lower.endsWith('/.mlx') || lower.endsWith('\\mlx')) return '.mlx'
  if (lower.endsWith('.gguf')) return '.gguf'
  if (lower.endsWith('.mlmodelc')) return '.mlmodelc'
  if (lower.endsWith('.mlpackage')) return '.mlpackage'
  if (lower.endsWith('.onnx')) return '.onnx'
  return undefined
}

export function isMlxPath(lower: string): boolean {
  return lower.endsWith('.mlx') || lower.endsWith('/.mlx') || lower.endsWith('\\mlx')
}
export function isGgufPath(lower: string): boolean {
  return lower.endsWith('.gguf')
}
export function isCoreMlPath(lower: string): boolean {
  return lower.endsWith('.mlmodelc') || lower.endsWith('.mlpackage')
}
export function isOnnxPath(lower: string): boolean {
  return lower.endsWith('.onnx')
}
