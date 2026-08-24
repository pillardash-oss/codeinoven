import type { ParsedModelIdentity, SpeechCapability, SpeechRuntime } from './types'

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

// ---- Model name breakup ----

function basenameFromPath(normalizedPath: string): string {
  const parts = normalizedPath.split(/[/\\]/).filter((s) => s.length > 0)
  return parts.length ? parts[parts.length - 1] : ''
}

function stripKnownExtension(base: string): string {
  const lower = base.toLowerCase()
  for (const ext of ['.mlmodelc', '.mlpackage', '.gguf', '.onnx', '.mlx'] as const) {
    if (lower.endsWith(ext)) return base.slice(0, base.length - ext.length)
  }
  return base
}

function titleCase(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1).toLowerCase()
}

const FAMILY_ALIASES: Record<string, string> = {
  parakeet: 'Parakeet',
  whisper: 'Whisper',
  kokoro: 'Kokoro',
  qwen: 'Qwen',
  sherpa: 'Sherpa',
  nemo: 'NeMo',
  fluidaudio: 'FluidAudio',
  tdt: 'TDT'
}

function formatSizeToken(tok: string): string {
  const m = tok.match(/^(\d+(?:\.\d+)?)(b|m|k)$/i)
  if (!m) return tok.toUpperCase()
  const num = m[1]
  const unit = m[2].toUpperCase()
  // 0.6b -> 0.6B
  return `${num}${unit}`
}

/**
 * Parse a pasted filesystem path into a human-readable model identity.
 * This is heuristic - it splits the basename on separators and classifies tokens.
 * Examples:
 *  parakeet-tdt-0.6b-v2 -> Parakeet / TDT / 0.6B / v2
 *  whisper-base-mlx-4bit -> Whisper / base / MLX / 4-bit
 */
export function parseModelIdentityFromPath(
  normalizedPath: string,
  runtimeHint?: SpeechRuntime | null
): ParsedModelIdentity | null {
  if (!normalizedPath || normalizedPath.trim().length === 0) return null
  const rawBasename = basenameFromPath(normalizedPath.trim())
  if (!rawBasename) return null
  // Drop trailing slash handling already done by split; check for known-ext stripping
  const baseWithoutExtension = stripKnownExtension(rawBasename)
  if (!baseWithoutExtension) return null
  // Avoid generic folder names that are not model-like
  const lowerBase = baseWithoutExtension.toLowerCase()
  if (['models', 'model', 'encoder', 'decoder', 'weights', 'preprocessor'].includes(lowerBase)) {
    return null
  }
  const rawTokens = baseWithoutExtension.split(/[-_\s]+/).filter(Boolean).flatMap((tok) => {
    // Keep dots inside size tokens like 0.6b; otherwise split lingering dots (e.g. foo.bar)
    if (/^\d+\.\d+[bmk]$/i.test(tok) || /^\d+\.\d+$/.test(tok)) return [tok]
    if (tok.includes('.')) return tok.split('.').filter(Boolean)
    return [tok]
  })
  if (rawTokens.length === 0) return null

  // Classify tokens
  let family: string | undefined
  let variant: string | undefined
  let size: string | undefined
  let version: string | undefined
  let quantization: string | undefined
  let languageHint: string | undefined

  const tokens = [...rawTokens]
  const lowerTokens = tokens.map((t) => t.toLowerCase())

  // Family is usually first token if known (handle suffixed tokens like Qwen2)
  const knownFamilies = new Set(['parakeet', 'whisper', 'kokoro', 'qwen', 'sherpa', 'nemo', 'fluidaudio'])
  const lowerFirst = lowerTokens[0] ?? ''
  const familyKey = [...knownFamilies].find((k) => lowerFirst === k || lowerFirst.startsWith(k))
  if (familyKey) {
    family = FAMILY_ALIASES[familyKey] ?? titleCase(familyKey)
  } else if (lowerTokens.some((tok) => tok === 'parakeet' || tok.startsWith('parakeet'))) {
    family = 'Parakeet'
  } else if (lowerTokens.some((tok) => tok === 'whisper' || tok.startsWith('whisper'))) {
    family = 'Whisper'
  } else if (lowerTokens.some((tok) => tok === 'kokoro' || tok.startsWith('kokoro'))) {
    family = 'Kokoro'
  } else if (lowerTokens.some((tok) => tok === 'qwen' || tok.startsWith('qwen'))) {
    family = 'Qwen'
  }

  // Variant: tdt, base, small, medium, large, turbo, v3 etc adjacent to family
  for (const tok of tokens) {
    const l = tok.toLowerCase()
    if (l === 'tdt') {
      variant = 'TDT'
      break
    }
  }
  if (!variant) {
    // whisper variants
    const variantCandidates = ['tiny', 'base', 'small', 'medium', 'large', 'turbo']
    for (const tok of tokens) {
      if (variantCandidates.includes(tok.toLowerCase())) {
        variant = tok.toLowerCase()
        break
      }
    }
  }

  // Size: 0.6b, 0.5b, 7b, 600m
  for (const tok of tokens) {
    if (/^\d+(?:\.\d+)?[bmk]$/i.test(tok)) {
      size = formatSizeToken(tok)
      break
    }
  }

  // Version: v2, v3, v1 etc
  for (const tok of tokens) {
    if (/^v\d+$/i.test(tok)) {
      version = tok.toLowerCase()
      break
    }
  }

  // Quantization: int8, 4bit, bf16, q4, etc
  for (const tok of tokens) {
    const l = tok.toLowerCase()
    if (l === 'int8' || l === 'int4' || /^\d+bit$/.test(l) || l === 'bf16' || l === 'fp16' || /^q\d.*/.test(l)) {
      quantization = l.includes('bit') ? l.replace('bit', '-bit') : l.toUpperCase() === 'BF16' ? 'BF16' : l.toUpperCase() === 'FP16' ? 'FP16' : l
      // normalize 4bit formatting
      if (/^\d+-bit$/i.test(quantization)) {
        quantization = quantization.toLowerCase().replace('-bit', '-bit')
        // keep as 4-bit
      }
      break
    }
  }

  // Language hint heuristic for parakeet
  if (family === 'Parakeet') {
    if (version === 'v2') languageHint = 'English'
    else if (version === 'v3') languageHint = 'Multilingual'
  }

  // Build display name
  const displayParts: string[] = []
  if (family) displayParts.push(family)
  if (variant) displayParts.push(variant.toUpperCase() === 'TDT' ? 'TDT' : variant)
  if (size) displayParts.push(size)
  if (version) displayParts.push(version)
  // Fallback to raw if nothing classified
  const displayName = displayParts.length ? displayParts.join(' ') : baseWithoutExtension

  const details: Array<{ label: string; value: string }> = []
  if (family) details.push({ label: 'Family', value: family })
  if (variant) details.push({ label: 'Variant', value: variant.toUpperCase() === 'TDT' ? 'TDT' : titleCase(variant) })
  if (size) details.push({ label: 'Size', value: size })
  if (version) details.push({ label: 'Version', value: version })
  if (quantization) details.push({ label: 'Quantization', value: quantization })
  if (languageHint) details.push({ label: 'Best for', value: languageHint })
  if (runtimeHint) details.push({ label: 'Runtime', value: runtimeHint })

  // Confidence heuristic
  let confidence: ParsedModelIdentity['confidence'] = 'low'
  if (family && (variant || size || version)) confidence = 'high'
  else if (family || size || version) confidence = 'medium'

  return {
    rawBasename,
    baseWithoutExtension,
    displayName,
    family,
    variant: variant ? (variant.toUpperCase() === 'TDT' ? 'TDT' : variant.toLowerCase()) : undefined,
    size,
    version,
    quantization,
    languageHint,
    runtimeHint: runtimeHint ?? undefined,
    confidence,
    tokens: rawTokens,
    details
  }
}

export function buildParsedIdentityForValidation(
  normalizedPath: string,
  runtime?: SpeechRuntime | null
): ParsedModelIdentity | null {
  // Only parse if the path looks like a model path (basename has at least 2 chars)
  const parsed = parseModelIdentityFromPath(normalizedPath, runtime)
  if (!parsed) return null
  // Filter out very low signal parses where we could not identify anything
  if (parsed.confidence === 'low' && !parsed.family && !parsed.size && !parsed.version) return null
  return parsed
}
