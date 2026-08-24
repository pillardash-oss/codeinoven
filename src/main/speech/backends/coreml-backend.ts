import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechCapability } from '../../../lib/speech/types'
import type { SpeechBackend, SpeechBackendArtifact, SpeechSynthesisInput, SpeechTranscribeInput } from '../speech-backend'

/**
 * Core ML adapter for Parakeet TDT and other .mlmodelc / .mlpackage bundles.
 * Runs only on Apple Silicon (darwin:arm64). Unlike the MLX worker, this
 * backend currently validates and reports capability without requiring a
 * separate helper binary — the model directory is inspected for compiled
 * Core ML bundles. Transcription via the native Core ML runtime is stubbed
 * with a clear error until the Swift bridge lands; import/validation/selection
 * already works so a pasted FluidAudio path becomes a selectable ASR model.
 */
export class CoreMlSpeechBackend implements SpeechBackend {
  readonly runtime = 'coreml' as const

  async capabilities(): Promise<SpeechCapability[]> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return []
    // Core ML itself is always available on Apple Silicon; ASR only.
    return ['asr']
  }

  async transcribe(input: SpeechTranscribeInput, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('Speech operation cancelled.')
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      throw new Error('Core ML transcription requires Apple Silicon (macOS arm64).')
    }
    // Validate the imported directory actually contains a compiled bundle.
    const hasBundle = await this.hasCoreMlBundle(input.artifact.directory)
    if (!hasBundle) {
      throw new Error(
        `Core ML model not found at ${input.artifact.directory}. Expected a folder containing .mlmodelc or .mlpackage (e.g. Encoder.mlmodelc).`
      )
    }
    // No native bridge yet — keep the error actionable and point to the
    // portable alternative that already works today.
    throw new Error(
      'Core ML transcription is not yet wired to the native runtime in this build. ' +
        'Your imported Core ML bundle is registered and selectable, but transcription will use the portable Parakeet sherpa-onnx builds until the Core ML Swift bridge ships. ' +
        'Download “Parakeet TDT v2/v3 · sherpa-onnx int8” from the Models → ASR list for working on-device ASR today.'
    )
  }

  async cleanup(transcript: string, _artifact: SpeechBackendArtifact, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('Speech operation cancelled.')
    throw new Error('Core ML does not support transcript cleanup. Use sherpa-onnx, MLX, or GGUF cleanup models.')
  }

  async synthesize(_input: SpeechSynthesisInput, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Speech operation cancelled.')
    throw new Error('Core ML does not support speech synthesis. Use an MLX or sherpa-onnx TTS model.')
  }

  async dispose(): Promise<void> {}

  private async hasCoreMlBundle(directory: string): Promise<boolean> {
    try {
      await access(directory)
    } catch {
      return false
    }
    try {
      const entries = await readdir(directory, { withFileTypes: true })
      // Direct bundle path (…/Encoder.mlmodelc) or a container that holds bundles (FluidAudio's parakeet-tdt-0.6b-v2/)
      const lower = directory.toLowerCase()
      if (lower.endsWith('.mlmodelc') || lower.endsWith('.mlpackage')) return true
      for (const entry of entries) {
        const name = entry.name.toLowerCase()
        if (entry.isDirectory() && (name.endsWith('.mlmodelc') || name.endsWith('.mlpackage'))) return true
        // Also accept the nested compiled form (coremldata.bin inside .mlmodelc)
        if (entry.isDirectory() && name === 'coremldata.bin') return true
      }
      // Check one level deeper for FluidAudio layout: the directory itself holds several *.mlmodelc dirs
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const inner = await readdir(join(directory, entry.name), { withFileTypes: true })
          for (const sub of inner) {
            if (sub.name.toLowerCase().endsWith('.mlmodelc') || sub.name.toLowerCase().endsWith('.mlpackage')) return true
          }
        } catch {
          // ignore
        }
      }
      return false
    } catch {
      return false
    }
  }
}
