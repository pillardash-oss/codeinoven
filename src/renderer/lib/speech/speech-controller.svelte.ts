import { invoke } from '$lib/ipc.svelte'
import type {
  SpeechDictationSpan,
  SpeechModelArtifact,
  SpeechRuntime,
  SpeechScope
} from '../../../lib/speech/types'
import type { SpeechEditorSnapshot, SpeechEditorTarget } from './editor-target'

export type RendererSpeechState =
  | { state: 'idle' }
  | { state: 'requesting-permission'; targetId: string }
  | {
      state: 'recording'
      targetId: string
      attemptId: string
      startedAt: number
      elapsedMs: number
    }
  | { state: 'stopping'; targetId: string; attemptId: string }
  | { state: 'transcribing'; targetId: string; attemptId: string }
  | { state: 'failed'; targetId?: string; message: string }

interface ActiveCapture {
  target: SpeechEditorTarget
  snapshot: SpeechEditorSnapshot
  scope: SpeechScope
  recorder: MediaRecorder
  stream: MediaStream
  sessionId: string
  attemptId: string
  startedAt: number
  uploadTail: Promise<void>
  queuedChunks: number
  uploadError: Error | null
}

const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'] as const
const CAPTURE_TIMESLICE_MS = 250
const PAUSE_UPLOAD_DEPTH = 4

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function selectedMimeType(): string {
  return MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? ''
}

class SpeechController {
  state = $state<RendererSpeechState>({ state: 'idle' })
  private active: ActiveCapture | null = null
  private elapsedTimer: ReturnType<typeof setInterval> | null = null
  private readonly spans = new Map<string, SpeechDictationSpan[]>()

  isActiveTarget(targetId: string): boolean {
    return 'targetId' in this.state && this.state.targetId === targetId
  }

  async start(
    target: SpeechEditorTarget,
    scope: SpeechScope,
    preparedSnapshot?: SpeechEditorSnapshot | null
  ): Promise<void> {
    if (this.active || !['idle', 'failed'].includes(this.state.state)) return
    const snapshot = preparedSnapshot ?? target.capture()
    if (!snapshot) {
      this.state = {
        state: 'failed',
        targetId: target.id,
        message: 'Focus the editor before recording.'
      }
      return
    }
    this.state = { state: 'requesting-permission', targetId: target.id }

    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      })
    } catch (cause) {
      const message = errorMessage(cause)
      await invoke('speech:recordPermissionFailure', scope, message).catch(() => undefined)
      this.state = { state: 'failed', targetId: target.id, message }
      return
    }

    const mimeType = selectedMimeType()
    let recorder: MediaRecorder
    let pendingSessionId: string | null = null
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000
      })
      const started = await invoke(
        'speech:beginCapture',
        scope,
        recorder.mimeType || mimeType || 'audio/webm'
      )
      if (!started.ok) throw new Error(started.error.message)
      pendingSessionId = started.value.sessionId
      const active: ActiveCapture = {
        target,
        snapshot,
        scope,
        recorder,
        stream,
        sessionId: started.value.sessionId,
        attemptId: started.value.attemptId,
        startedAt: performance.now(),
        uploadTail: Promise.resolve(),
        queuedChunks: 0,
        uploadError: null
      }
      this.active = active
      recorder.ondataavailable = (event) => this.queueChunk(active, event.data)
      recorder.onerror = () => {
        active.uploadError ??= new Error('The recording device stopped unexpectedly.')
        void this.stop()
      }
      for (const track of stream.getAudioTracks()) {
        track.addEventListener(
          'ended',
          () => {
            if (this.active !== active || recorder.state === 'inactive') return
            active.uploadError ??= new Error(
              'Microphone access was revoked or the device was disconnected.'
            )
            void this.stop()
          },
          { once: true }
        )
      }
      recorder.start(CAPTURE_TIMESLICE_MS)
      pendingSessionId = null
      this.state = {
        state: 'recording',
        targetId: target.id,
        attemptId: active.attemptId,
        startedAt: Date.now(),
        elapsedMs: 0
      }
      this.startElapsedTimer(active)
      this.playCue('started')
    } catch (cause) {
      if (pendingSessionId) {
        await invoke('speech:failCapture', pendingSessionId, errorMessage(cause)).catch(
          () => undefined
        )
      }
      for (const track of stream.getTracks()) track.stop()
      this.active = null
      this.state = { state: 'failed', targetId: target.id, message: errorMessage(cause) }
    }
  }

  async stop(): Promise<void> {
    const active = this.active
    if (!active || active.recorder.state === 'inactive') return
    this.clearElapsedTimer()
    this.state = { state: 'stopping', targetId: active.target.id, attemptId: active.attemptId }
    await new Promise<void>((resolve) => {
      active.recorder.addEventListener('stop', () => resolve(), { once: true })
      active.recorder.stop()
    })
    for (const track of active.stream.getTracks()) track.stop()

    let finalized = false
    try {
      await active.uploadTail
      if (active.uploadError) throw active.uploadError
      const durationMs = Math.max(0, performance.now() - active.startedAt)
      const finished = await invoke(
        'speech:finishCapture',
        active.sessionId,
        Math.round(durationMs)
      )
      if (!finished.ok) throw new Error(finished.error.message)
      finalized = true
      this.playCue('stopped')
      this.state = {
        state: 'transcribing',
        targetId: active.target.id,
        attemptId: active.attemptId
      }
      const selection = await this.selectAsrArtifact()
      const result = await invoke(
        'speech:transcribe',
        active.attemptId,
        selection.runtime,
        selection.artifact.id,
        'auto'
      )
      if (!result.ok) throw new Error(result.error.message)
      const transcript = result.value.finalTranscript
      await invoke('clipboard:writeText', transcript)
      const inserted = active.target.apply(active.snapshot, transcript)
      this.playCue('completed')
      if (!inserted.ok) {
        this.state = {
          state: 'failed',
          targetId: active.target.id,
          message:
            'Transcript copied to the clipboard. The original editor changed, so it was not inserted.'
        }
        return
      }
      const span: SpeechDictationSpan = {
        id: crypto.randomUUID(),
        attemptId: active.attemptId,
        editorId: active.target.id,
        insertedText: transcript,
        startOffset: inserted.startOffset,
        endOffset: inserted.endOffset,
        insertedAt: Date.now(),
        scope: structuredClone(active.scope)
      }
      const current = this.spans.get(active.target.id) ?? []
      this.spans.set(active.target.id, [...current.slice(-7), span])
      this.state = { state: 'idle' }
    } catch (cause) {
      const message = errorMessage(cause)
      await (
        finalized
          ? invoke('speech:markAttemptFailure', active.attemptId, message)
          : invoke('speech:failCapture', active.sessionId, message)
      ).catch(() => undefined)
      this.state = { state: 'failed', targetId: active.target.id, message: errorMessage(cause) }
    } finally {
      this.active = null
    }
  }

  resetFailure(targetId: string): void {
    if (this.state.state === 'failed' && this.state.targetId === targetId)
      this.state = { state: 'idle' }
  }

  observeSent(targetId: string, sentText: string): void {
    const spans = this.spans.get(targetId)
    if (!spans?.length) return
    this.spans.delete(targetId)
    const sentAt = Date.now()
    for (const span of spans) {
      void invoke('speech:observeCorrection', { span, sentText, sentAt })
    }
  }

  private queueChunk(active: ActiveCapture, blob: Blob): void {
    if (blob.size === 0) return
    active.queuedChunks += 1
    if (active.queuedChunks >= PAUSE_UPLOAD_DEPTH && active.recorder.state === 'recording') {
      active.recorder.pause()
    }
    active.uploadTail = active.uploadTail
      .then(async () => {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const appended = await invoke('speech:appendCapture', active.sessionId, bytes)
        if (!appended.ok) throw new Error(appended.error.message)
      })
      .catch((cause: unknown) => {
        active.uploadError = cause instanceof Error ? cause : new Error(String(cause))
        void this.stop()
      })
      .finally(() => {
        active.queuedChunks -= 1
        if (
          active.queuedChunks < PAUSE_UPLOAD_DEPTH &&
          active.recorder.state === 'paused' &&
          !active.uploadError
        ) {
          active.recorder.resume()
        }
      })
  }

  private startElapsedTimer(active: ActiveCapture): void {
    this.clearElapsedTimer()
    this.elapsedTimer = setInterval(() => {
      if (this.active !== active || this.state.state !== 'recording') return
      this.state.elapsedMs = Math.max(0, performance.now() - active.startedAt)
    }, 250)
  }

  private clearElapsedTimer(): void {
    if (this.elapsedTimer) clearInterval(this.elapsedTimer)
    this.elapsedTimer = null
  }

  private async selectAsrArtifact(): Promise<{
    runtime: SpeechRuntime
    artifact: SpeechModelArtifact
  }> {
    const [capabilities, catalog] = await Promise.all([
      invoke('speech:getCapabilities'),
      invoke('speech:getCatalog')
    ])
    if (!capabilities.ok) throw new Error(capabilities.error.message)
    if (!catalog.ok) throw new Error(catalog.error.message)
    const runtime = capabilities.value.selectedRuntime
    if (!runtime) {
      throw new Error(
        `${capabilities.value.recommendedRuntime === 'mlx' ? 'MLX' : 'sherpa-onnx'} is unavailable on this device.`
      )
    }
    const installedIds = new Set(
      capabilities.value.installedArtifacts
        .filter((artifact) => artifact.available && artifact.runtime === runtime)
        .map((artifact) => artifact.artifactId)
    )
    const artifact = catalog.value.artifacts.find(
      (candidate) =>
        candidate.runtime === runtime &&
        candidate.capability === 'asr' &&
        candidate.qualification.status === 'qualified' &&
        installedIds.has(candidate.id)
    )
    if (!artifact)
      throw new Error(`Install a qualified ${runtime} speech-to-text model in Sound settings.`)
    return { runtime, artifact }
  }

  private playCue(kind: 'started' | 'stopped' | 'completed'): void {
    const AudioContextConstructor = window.AudioContext
    const context = new AudioContextConstructor()
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    const frequency = kind === 'started' ? 520 : kind === 'stopped' ? 360 : 700
    oscillator.frequency.setValueAtTime(frequency, context.currentTime)
    gain.gain.setValueAtTime(0.0001, context.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.04, context.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.09)
    oscillator.connect(gain)
    gain.connect(context.destination)
    oscillator.start()
    oscillator.stop(context.currentTime + 0.1)
    oscillator.addEventListener('ended', () => void context.close(), { once: true })
  }
}

export const speechController = new SpeechController()
