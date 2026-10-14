import type {
  VoiceSendIntent,
  VoiceSendLevel,
  VoiceSendStage,
  VoiceTranscriptionRecord
} from './speech-controller-types'

/** Structural view of the thread the user is currently looking at. */
export interface ViewedThread {
  id: string
  projectId: string
}

export function stageForLevel(level: VoiceSendLevel): VoiceSendStage {
  return level === 2 ? 'steer' : 'send'
}

/**
 * The next rung of the arm/escalate ladder, and it only ever steps over the
 * transcript: a fresh arm sends the transcript when it lands, and the next
 * press steers that transcript into the running turn. A press past the top
 * clears the intent instead, which the caller handles.
 */
export function nextVoiceSendLevel(current: VoiceSendLevel | undefined): VoiceSendLevel {
  return current === undefined ? 1 : 2
}

/**
 * The dictation an arming gesture applies to. A pinch on a specific mic
 * button pins its own target; the global shortcut prefers a dictation that is
 * already armed, then the one on the thread being viewed, then the newest.
 * The user who walked away mid-recording is exactly who arms this remotely.
 */
export function selectVoiceSendCandidate(
  transcribing: readonly VoiceTranscriptionRecord[],
  voiceSends: readonly VoiceSendIntent[],
  targetId: string | undefined,
  viewed: ViewedThread | null
): VoiceTranscriptionRecord | null {
  const candidates = transcribing.filter((entry) => entry.autoSend)
  if (candidates.length === 0) return null
  if (targetId) return candidates.find((entry) => entry.targetId === targetId) ?? null
  const armed = candidates.filter((entry) =>
    voiceSends.some((intent) => intent.attemptId === entry.attemptId)
  )
  if (armed.length > 0) return armed[armed.length - 1]
  const onView = viewed
    ? candidates.find(
        (entry) =>
          entry.scope.kind !== 'global' &&
          entry.scope.threadId === viewed.id &&
          (entry.scope.kind !== 'project' || entry.scope.projectId === viewed.projectId)
      )
    : undefined
  return onView ?? candidates[candidates.length - 1]
}
