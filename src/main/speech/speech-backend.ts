import type { SpeechCapability, SpeechRuntime } from '../../lib/speech/types'

export interface SpeechBackendArtifact {
  id: string
  directory: string
  modelFamily?: 'whisper' | 'parakeet'
}

export interface SpeechTranscribeInput {
  artifact: SpeechBackendArtifact
  audioPath: string
  language: string | 'auto'
}

export interface SpeechSynthesisInput {
  artifact: SpeechBackendArtifact
  text: string
  voiceId: string
  outputPath: string
}

export interface SpeechBackend {
  readonly runtime: SpeechRuntime
  capabilities(): Promise<SpeechCapability[]>
  warmup?(artifact: SpeechBackendArtifact, signal: AbortSignal): Promise<void>
  transcribe(input: SpeechTranscribeInput, signal: AbortSignal): Promise<string>
  cleanup(transcript: string, artifact: SpeechBackendArtifact, signal: AbortSignal): Promise<string>
  synthesize(input: SpeechSynthesisInput, signal: AbortSignal): Promise<void>
  dispose(): Promise<void>
}
