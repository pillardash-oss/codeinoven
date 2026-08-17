/** Zeroes out a transition duration when the user has asked the OS for reduced
 *  motion, so panel/tree animations become instant show/hide instead of skipped
 *  entirely (which would otherwise require a second code path per component). */
export function motionDuration(ms: number): number {
  if (typeof window === 'undefined') return ms
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms
}
