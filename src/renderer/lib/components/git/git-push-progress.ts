import type { GitPushProgress } from '$shared/types'

/**
 * Percentage bands for the stages git reports while pushing.
 *
 * git reports each stage on its own scale, so its own number restarts three
 * times in one push: counting goes to 100, compressing goes to 100, writing goes
 * to 100. Handing that straight to the button makes a healthy push read as
 * finished, restarted, finished, restarted. The bands fold the stages into one
 * monotonic run instead: the cheap stages share the first third, and writing the
 * pack   the part that actually travels   owns the rest.
 *
 * A stage this build does not know keeps git's own number, so a future git may
 * add a stage without the panel showing a lie.
 */
const STAGE_BANDS: Readonly<Record<string, readonly [start: number, end: number]>> = {
  counting: [0, 8],
  compressing: [8, 30],
  writing: [30, 100]
}

/**
 * The overall percentage of a push in flight, 0-100, from the stage git is in
 * and how far through that stage it is.
 */
export function pushPercent(progress: GitPushProgress): number {
  const raw = Math.min(100, Math.max(0, progress.percent))
  const band = STAGE_BANDS[progress.stage]
  if (!band) return Math.round(raw)
  const [start, end] = band
  return Math.round(start + ((end - start) * raw) / 100)
}
