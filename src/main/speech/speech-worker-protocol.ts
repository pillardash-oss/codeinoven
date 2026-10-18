export type SpeechWorkerRequest =
  | {
      id: string
      kind: 'warmup'
      modelDirectory: string
      modelFamily?: 'whisper' | 'parakeet'
    }
  | {
      id: string
      kind: 'transcribe'
      modelDirectory: string
      audioPath: string
      language: string | 'auto'
      modelFamily?: 'whisper' | 'parakeet'
    }
  | { id: string; kind: 'cleanup'; modelDirectory: string; transcript: string }
  | {
      id: string
      kind: 'synthesize'
      modelDirectory: string
      text: string
      speakerId: number
      outputPath: string
    }
  | { id: string; kind: 'shutdown' }

export type SpeechWorkerResponse =
  | { id: string; ok: true; kind: 'warmup' }
  | {
      id: string
      ok: true
      kind: 'transcribe'
      text: string
      words?: { text: string; start: number; end: number }[]
    }
  | { id: string; ok: true; kind: 'cleanup'; text: string }
  | { id: string; ok: true; kind: 'synthesize' | 'shutdown' }
  | { id: string; ok: false; error: string }
