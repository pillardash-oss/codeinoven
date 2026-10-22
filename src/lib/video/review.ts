export const VIDEO_REVIEW_RUBRIC = 'video-v1'

export interface VideoReviewEvidence {
  frames: { time: number; evidence: string }[]
  playback: string
  audio: string
}

const observation = { type: 'string', minLength: 1, maxLength: 2000 }
export const VIDEO_REVIEW_EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    frames: {
      type: 'array',
      minItems: 3,
      maxItems: 24,
      items: {
        type: 'object',
        properties: { time: { type: 'number', minimum: 0 }, evidence: observation },
        required: ['time', 'evidence'],
        additionalProperties: false
      }
    },
    playback: observation,
    audio: observation
  },
  required: ['frames', 'playback', 'audio'],
  additionalProperties: false
}

/** Validate submitted observations, not whether a model actually watched them. */
export function validateVideoReviewEvidence(
  raw: unknown,
  duration: number,
  fps: number
): VideoReviewEvidence {
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 2000
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Video critique requires frame, playback and audio evidence')
  const value = raw as Record<string, unknown>
  if (!text(value['playback']) || !text(value['audio']))
    throw new Error('Describe observed playback and audio, or the verified intentional silence')
  const frames = value['frames']
  if (!Array.isArray(frames) || frames.length < 3 || frames.length > 24)
    throw new Error('Video critique requires 3 to 24 inspected frames')
  const inspected = frames.map((frame: unknown) => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame))
      throw new Error('Each reviewed frame needs a time and observation')
    const { time, evidence } = frame as Record<string, unknown>
    if (
      typeof time !== 'number' ||
      !Number.isFinite(time) ||
      time < 0 ||
      time > duration ||
      !text(evidence)
    )
      throw new Error('Reviewed frame times must be on the composition timeline')
    return { time, evidence }
  })
  const frameStep = 1 / fps
  if (
    !inspected.some((frame) => frame.time <= frameStep) ||
    !inspected.some((frame) => Math.abs(frame.time - duration / 2) <= duration / 4) ||
    !inspected.some((frame) => frame.time >= Math.max(0, duration - frameStep - 0.001))
  )
    throw new Error('Inspect opening, middle and closing frames before grading the film')
  return { frames: inspected, playback: value['playback'], audio: value['audio'] }
}
