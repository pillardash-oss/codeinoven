import type {
  SpeechModelArtifact,
  SpeechPreparedPlayback,
  SpeechRuntime,
  SpeechScope,
  SpeechSynthesizedSegment
} from '../../../lib/speech/types'
import type { SpeechEditorSnapshot, SpeechEditorTarget } from './editor-target'

export type RendererSpeechState =
  | { state: 'idle' }
  /** Optimistic phase between the user's trigger and the capture pipeline
   *  answering. Rendered exactly like an active recording so the mic button
   *  flips instantly; every begin failure settles into `failed`. */
  | { state: 'starting'; targetId: string }
  | {
      state: 'recording'
      targetId: string
      attemptId: string
      startedAt: number
      elapsedMs: number
    }
  | { state: 'stopping'; targetId: string; attemptId: string }
  | { state: 'failed'; targetId?: string; message: string }

/**
 * How an armed dictation delivers itself once its transcript lands.
 *
 * - `send`: the transcript is dispatched when it arrives (queueing behind a
 *   running turn, exactly like the send button).
 * - `steer`: the transcript is forced into the running turn, interrupting it.
 */
export type VoiceSendStage = 'send' | 'steer'

/** Escalation level of an armed dictation: 1 send, 2 send after steering the
 *  box content now, 3 steer the transcript itself. A press at 3 clears the
 *  intent instead of escalating past it, so the ladder is a cycle. */
export type VoiceSendLevel = 1 | 2 | 3

/** One detached transcription job: the mic has closed, the transcript has not
 *  landed yet. */
export interface VoiceTranscriptionRecord {
  attemptId: string
  targetId: string
  scope: SpeechScope
  /**
   * The editor the transcript will be inserted into. Held so the delivery can
   * ask the live editor to dispatch itself instead of guessing at its content,
   * since `autoSend.isLive()` is the aliveness probe for that editor.
   */
  target: SpeechEditorTarget
  /** The recording editor can dispatch its own content as a message (the chat
   *  composer). Dictation armed on a plain editor has nothing to send for. */
  autoSend: boolean
}

/** The user's armed intent for one in-flight transcription. */
export interface VoiceSendIntent {
  attemptId: string
  targetId: string
  target: SpeechEditorTarget
  scope: SpeechScope
  level: VoiceSendLevel
}

export interface ActiveCapture {
  target: SpeechEditorTarget
  snapshot: SpeechEditorSnapshot
  scope: SpeechScope
  recorder: MediaRecorder | null
  stream: MediaStream | null
  native: boolean
  sessionId: string
  attemptId: string
  startedAt: number
  uploadTail: Promise<void>
  queuedChunks: number
  uploadError: Error | null
}

export interface ActivePlayback {
  prepared: SpeechPreparedPlayback
  runtime: SpeechRuntime
  artifact: SpeechModelArtifact
  voiceId: string
  audio: HTMLAudioElement | null
  /**
   * Blob URL per segment, indexed by segment index. A `null` slot is a block
   * skipped after a synthesis failure, which keeps later indexes aligned and can
   * still be synthesized on demand when the user seeks back into it.
   */
  retainedUrls: Array<string | null>
  /** Media duration per retained segment; NaN until metadata loads. */
  durations: number[]
  /** Prefetch handle plus the segment index it belongs to. */
  next: Promise<SpeechSynthesizedSegment> | null
  nextIndex: number | null
  /** Bumped whenever the user relocates the playhead; invalidates stale chains. */
  generation: number
  index: number
  /** Back-to-back segment synthesis failures before the session is abandoned. */
  consecutiveFailures: number
}
