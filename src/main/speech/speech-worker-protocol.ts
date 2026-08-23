export type SpeechWorkerRequest =
  | {
      id: string
      kind: 'transcribe'
      modelDirectory: string
      audioPath: string
      language: string | 'auto'
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
  | { id: string; ok: true; kind: 'transcribe' | 'cleanup'; text: string }
  | { id: string; ok: true; kind: 'synthesize' | 'shutdown' }
  | { id: string; ok: false; error: string }
