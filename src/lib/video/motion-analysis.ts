export interface MotionTrackingPoint {
  time: number
  x: number
  y: number
  confidence: number
}
/** Fit the recorded trajectory, not the creator's original spring constants. */
export function analyzeMotionPoints(points: MotionTrackingPoint[]) {
  const reliable = points.filter((p) => p.confidence >= 0.5)
  if (reliable.length < 3) throw new Error('At least three reliable tracking samples are needed')
  const first = reliable[0],
    last = reliable[reliable.length - 1]
  const dx = last.x - first.x,
    dy = last.y - first.y,
    length2 = dx * dx + dy * dy
  if (length2 < 0.0001 || last.time <= first.time)
    throw new Error(
      'No measurable net movement. Select a shorter interval with a clear start and end.'
    )
  const samples = reliable.map((p) => ({
    time: p.time,
    progress: ((p.x - first.x) * dx + (p.y - first.y) * dy) / length2,
    confidence: p.confidence
  }))
  const curves: { name: string; sample: (t: number) => number }[] = [
    { name: 'linear', sample: (t) => t },
    { name: 'ease-in-quad', sample: (t) => t * t },
    { name: 'ease-out-quad', sample: (t) => 1 - (1 - t) ** 2 },
    { name: 'ease-in-out-quad', sample: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2) },
    { name: 'ease-in-cubic', sample: (t) => t * t * t },
    { name: 'ease-out-cubic', sample: (t) => 1 - (1 - t) ** 3 },
    {
      name: 'ease-in-out-cubic',
      sample: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
    }
  ]
  const ranked = curves
    .map((curve) => ({
      name: curve.name,
      rmse: Math.sqrt(
        samples.reduce(
          (sum, p) =>
            sum +
            (p.progress - curve.sample((p.time - first.time) / (last.time - first.time))) ** 2,
          0
        ) / samples.length
      )
    }))
    .sort((a, b) => a.rmse - b.rmse)
  return {
    method: 'projected-template-tracking',
    range: { start: first.time, end: last.time, duration: last.time - first.time },
    displacement: { x: dx, y: dy },
    sampleCount: points.length,
    reliableSamples: reliable.length,
    meanTrackingConfidence: reliable.reduce((n, p) => n + p.confidence, 0) / reliable.length,
    overshoot: Math.max(0, ...samples.map((p) => p.progress - 1)),
    fit: ranked[0],
    alternatives: ranked.slice(1, 3),
    samples,
    limitations: [
      '10 Hz samples of local appearance, not semantic object tracking.',
      'Fit is an estimate against a small curve family, not measured CSS easing or physical spring constants.',
      'Choose a single movement interval; holds, camera changes and occlusion affect the fit.'
    ]
  }
}
