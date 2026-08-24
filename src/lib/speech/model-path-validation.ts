import type { SpeechRuntime } from './types'

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

export const SUPPORTED_MODEL_EXTENSIONS = ['.mlx', '.gguf'] as const

export function describeSupportedFormats(): string {
  return 'Supported formats: .mlx directory/file (Apple Silicon) or .gguf file / folder containing .gguf.'
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
  return null
}

export function extensionForDisplay(normalizedPath: string): string | undefined {
  const lower = normalizedPath.toLowerCase()
  if (lower.endsWith('.mlx') || lower.endsWith('/.mlx') || lower.endsWith('\\mlx')) return '.mlx'
  if (lower.endsWith('.gguf')) return '.gguf'
  return undefined
}
