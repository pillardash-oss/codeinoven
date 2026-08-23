import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import type { SpeechSegment } from '../../lib/speech/types'

export interface PreparedSpeechPlayback {
  sessionId: string
  messageId: string
  segments: SpeechSegment[]
}

/** One app-wide playback lease. Segment synthesis remains owned by the bounded backend queue. */
export class TtsPlaybackService {
  private active: PreparedSpeechPlayback | null = null

  prepare(messageId: string, segments: SpeechSegment[]): PreparedSpeechPlayback {
    const sessionId = randomUUID()
    this.active = { sessionId, messageId, segments: structuredClone(segments) }
    return structuredClone(this.active)
  }

  assertActive(sessionId: string): void {
    if (this.active?.sessionId !== sessionId) throw new Error('Playback session is stale.')
  }

  segment(sessionId: string, segmentIndex: number): SpeechSegment {
    this.assertActive(sessionId)
    const segment = this.active?.segments[segmentIndex]
    if (!segment) throw new Error('Playback segment was not found.')
    return structuredClone(segment)
  }

  cancel(sessionId?: string): boolean {
    if (!this.active || (sessionId && this.active.sessionId !== sessionId)) return false
    this.active = null
    return true
  }

  async consumeAudio(path: string): Promise<Uint8Array<ArrayBuffer>> {
    const bytes = await readFile(path)
    await rm(path, { force: true })
    return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
  }
}
