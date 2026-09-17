import { readdir } from 'node:fs/promises'
import {
  CAPABILITY_RUNTIMES,
  buildParsedIdentityForValidation,
  describeSupportedFormatsForCapability,
  normalizePastedPath
} from '../../../lib/speech/model-path-validation'
import type {
  ModelPathValidationResult,
  SpeechCapability,
  SpeechCapabilitySnapshot,
  SpeechRuntime
} from '../../../lib/speech/types'

/**
 * Validate a pasted filesystem path without registering it.
 * Runs entirely in the main process (filesystem access) and returns a
 * structured validation result for inline UI feedback. Never logs raw paths.
 */
export async function validateSpeechModelPath(
  rawPath: string,
  capability: SpeechCapability,
  platformTarget: SpeechCapabilitySnapshot['target']
): Promise<ModelPathValidationResult> {
  const { normalized, wasNormalized } = normalizePastedPath(rawPath)
  const cap: SpeechCapability =
    capability === 'asr' || capability === 'tts' || capability === 'cleanup' ? capability : 'asr'
  const allowed = CAPABILITY_RUNTIMES[cap]
  const hint = describeSupportedFormatsForCapability(cap)
  const parsedFor = (runtime: import('../../../lib/speech/types').SpeechRuntime | null) =>
    buildParsedIdentityForValidation(normalized, runtime)
  if (normalized.length === 0) {
    return {
      ok: false,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      code: 'empty',
      reason: hint,
      parsedIdentity: parsedFor(
        null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }
  if (normalized.length > 4_096) {
    return {
      ok: false,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      code: 'unsupported-format',
      reason: 'Path is too long. Paste a local file or folder path.',
      parsedIdentity: parsedFor(
        null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }
  const lower = normalized.toLowerCase()
  const isMlx = lower.endsWith('.mlx') || lower.endsWith('/.mlx') || lower.endsWith('\\mlx')
  const isGgufFile = lower.endsWith('.gguf')
  const isCoreMlFile = lower.endsWith('.mlmodelc') || lower.endsWith('.mlpackage')
  const isOnnxFile = lower.endsWith('.onnx')
  // Stat the path (batched, non-blocking) - avoid blocking renderer
  let stat: { isFile: boolean; isDirectory: boolean } | null
  try {
    const { stat: fsStat } = await import('node:fs/promises')
    const s = await fsStat(normalized)
    stat = { isFile: s.isFile(), isDirectory: s.isDirectory() }
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException)?.code ?? ''
    if (code === 'ENOENT') {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'not-found',
        reason: 'No file or folder exists at that path. Check the path and try again.',
        parsedIdentity: parsedFor(
          null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'permission-denied',
        reason: 'Permission denied at that path. Check access and try again.',
        parsedIdentity: parsedFor(
          null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    return {
      ok: false,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      code: 'not-found',
      reason: 'That path cannot be read. Verify it and try again.',
      parsedIdentity: parsedFor(
        null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }

  const forbid = (runtime: string, reason: string): ModelPathValidationResult => ({
    ok: false,
    capability: cap,
    normalizedPath: normalized,
    wasNormalized,
    runtime: runtime as SpeechRuntime,
    code: 'unsupported-format',
    reason,
    detectedExtension:
      runtime === 'gguf'
        ? '.gguf'
        : runtime === 'mlx'
          ? '.mlx'
          : runtime === 'coreml'
            ? '.mlmodelc'
            : '.onnx',
    parsedIdentity: parsedFor(runtime as import('../../../lib/speech/types').SpeechRuntime)
  })

  // Direct file hits - check capability before accepting
  if (isMlx) {
    if (!allowed.includes('mlx')) {
      return forbid('mlx', `MLX models cannot run as ${cap.toUpperCase()}. ${hint}`)
    }
    const target = platformTarget
    if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'mlx',
        code: 'platform-unsupported',
        reason: 'MLX models are only supported on Apple Silicon.',
        detectedExtension: '.mlx',
        parsedIdentity: parsedFor(
          'mlx' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    return {
      ok: true,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      runtime: 'mlx',
      code: 'valid',
      reason: `Supported model found   MLX ${cap.toUpperCase()}   ready to import.`,
      detectedExtension: '.mlx',
      parsedIdentity: parsedFor(
        'mlx' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }
  if (isGgufFile) {
    if (!allowed.includes('gguf')) {
      return forbid(
        'gguf',
        `GGUF models only run as LLM / Cleanup, not as ${cap.toUpperCase()}. ${hint}`
      )
    }
    if (stat?.isDirectory) {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'unsupported-format',
        reason: 'That .gguf path is a directory. Paste the file path to the .gguf.',
        detectedExtension: '.gguf',
        parsedIdentity: parsedFor(
          null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    return {
      ok: true,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      runtime: 'gguf',
      code: 'valid',
      reason: 'Supported model found   GGUF (LLM / Cleanup)   ready to import.',
      detectedExtension: '.gguf',
      parsedIdentity: parsedFor(
        'gguf' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }
  if (isCoreMlFile) {
    if (!allowed.includes('coreml')) {
      return forbid(
        'coreml',
        `Core ML bundles only run as ASR, not as ${cap.toUpperCase()}. ${hint}`
      )
    }
    const target = platformTarget
    if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'coreml',
        code: 'platform-unsupported',
        reason: 'Core ML models are only supported on Apple Silicon.',
        detectedExtension: '.mlmodelc',
        parsedIdentity: parsedFor(
          'coreml' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    return {
      ok: true,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      runtime: 'coreml',
      code: 'valid',
      reason: 'Supported model found   Core ML ASR bundle   ready to import.',
      detectedExtension: lower.endsWith('.mlpackage') ? '.mlpackage' : '.mlmodelc',
      parsedIdentity: parsedFor(
        'coreml' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }
  if (isOnnxFile) {
    if (!allowed.includes('sherpa-onnx')) {
      return forbid(
        'sherpa-onnx',
        `ONNX models cannot run as ${cap.toUpperCase()} in this context. ${hint}`
      )
    }
    return {
      ok: true,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      runtime: 'sherpa-onnx',
      code: 'valid',
      reason: 'Supported model found   sherpa-onnx (.onnx)   ready to import.',
      detectedExtension: '.onnx',
      parsedIdentity: parsedFor(
        'sherpa-onnx' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }

  // Directory scans - contextual per capability
  if (stat?.isDirectory) {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(normalized, { withFileTypes: true })
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code ?? ''
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          code: 'permission-denied',
          reason: 'Permission denied reading that folder.',
          parsedIdentity: parsedFor(
            null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      return {
        ok: false,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        code: 'unsupported-format',
        reason: hint,
        parsedIdentity: parsedFor(
          null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    const lowerNames = entries.map((e) => e.name.toLowerCase())
    const hasGguf = lowerNames.some((n) => n.endsWith('.gguf'))
    const hasOnnx = lowerNames.some((n) => n.endsWith('.onnx'))
    const hasCoreMl = entries.some(
      (e) =>
        e.isDirectory() &&
        (e.name.toLowerCase().endsWith('.mlmodelc') || e.name.toLowerCase().endsWith('.mlpackage'))
    )
    const hasTokens = lowerNames.includes('tokens.txt')

    // Core ML bundle folder (e.g. FluidAudio parakeet-tdt-0.6b-v2)
    if (hasCoreMl) {
      if (!allowed.includes('coreml')) {
        return forbid(
          'coreml',
          `That folder contains a Core ML bundle   only valid for ASR, not ${cap.toUpperCase()}. ${hint}`
        )
      }
      const target = platformTarget
      if (target.platform !== 'darwin' || target.architecture !== 'arm64') {
        return {
          ok: false,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'coreml',
          code: 'platform-unsupported',
          reason: 'Core ML models are only supported on Apple Silicon.',
          detectedExtension: '.mlmodelc',
          parsedIdentity: parsedFor(
            'coreml' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'coreml',
        code: 'valid',
        reason: 'Supported model found   folder containing Core ML ASR bundle   ready to import.',
        detectedExtension: '.mlmodelc',
        parsedIdentity: parsedFor(
          'coreml' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    if (hasGguf) {
      if (!allowed.includes('gguf')) {
        return forbid(
          'gguf',
          `That folder contains .gguf   only valid for LLM / Cleanup, not ${cap.toUpperCase()}. ${hint}`
        )
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'gguf',
        code: 'valid',
        reason: 'Supported model found   folder containing .gguf   ready to import.',
        detectedExtension: '.gguf',
        parsedIdentity: parsedFor(
          'gguf' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    if (hasOnnx) {
      if (!allowed.includes('sherpa-onnx')) {
        return forbid(
          'sherpa-onnx',
          `That folder contains .onnx   not valid for ${cap.toUpperCase()}. ${hint}`
        )
      }
      // Heuristic: sherpa-onnx ASR/TTS expects tokens.txt sibling; warn but still accept
      if (cap === 'asr' && !hasTokens) {
        return {
          ok: true,
          capability: cap,
          normalizedPath: normalized,
          wasNormalized,
          runtime: 'sherpa-onnx',
          code: 'valid',
          reason:
            'Found sherpa-onnx model (.onnx)   missing tokens.txt; may still import but verify the directory is a full sherpa model.',
          detectedExtension: '.onnx',
          parsedIdentity: parsedFor(
            'sherpa-onnx' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
          )
        }
      }
      return {
        ok: true,
        capability: cap,
        normalizedPath: normalized,
        wasNormalized,
        runtime: 'sherpa-onnx',
        code: 'valid',
        reason: `Supported model found   sherpa-onnx ${cap.toUpperCase()} folder   ready to import.`,
        detectedExtension: '.onnx',
        parsedIdentity: parsedFor(
          'sherpa-onnx' as unknown as import('../../../lib/speech/types').SpeechRuntime | null
        )
      }
    }
    return {
      ok: false,
      capability: cap,
      normalizedPath: normalized,
      wasNormalized,
      code: 'unsupported-format',
      reason: hint,
      detectedExtension: undefined,
      parsedIdentity: parsedFor(
        null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
      )
    }
  }
  // File with unsupported extension
  return {
    ok: false,
    capability: cap,
    normalizedPath: normalized,
    wasNormalized,
    code: 'unsupported-format',
    reason: hint,
    detectedExtension: undefined,
    parsedIdentity: parsedFor(
      null as unknown as import('../../../lib/speech/types').SpeechRuntime | null
    )
  }
}
