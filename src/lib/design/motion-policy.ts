/** Original motion policy shared by authored controls and their tools. */
export const MOTION_DURATIONS = { immediate: 0, feedback: 120, control: 160, reveal: 220 } as const
export interface AuthoredMotion {
  purpose: 'feedback' | 'continuity' | 'attention'
  trigger: 'enter' | 'hover' | 'press' | 'focus'
  frequency: 'frequent' | 'occasional'
  duration: keyof typeof MOTION_DURATIONS
  easing: 'ease-out' | 'ease-in-out' | 'linear'
  from: { opacity: number; x: number; y: number; scale: number; rotate: number }
  to: { opacity: number; x: number; y: number; scale: number; rotate: number }
}
export function validateAuthoredMotion(raw: unknown): AuthoredMotion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('motion is required')
  const value = raw as Record<string, unknown>
  const choice = <T extends string>(key: string, options: readonly T[]): T => {
    const item = value[key]
    if (typeof item !== 'string' || !options.includes(item as T))
      throw new Error(`Invalid motion ${key}`)
    return item as T
  }
  const state = (key: string): AuthoredMotion['from'] => {
    const input = value[key]
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error(`Invalid ${key} state`)
    const record = input as Record<string, unknown>
    const number = (name: string, fallback: number, min: number, max: number): number => {
      const item = record[name] ?? fallback
      if (typeof item !== 'number' || !Number.isFinite(item) || item < min || item > max)
        throw new Error(`Invalid ${key}.${name}`)
      return item
    }
    return {
      opacity: number('opacity', 1, 0, 1),
      x: number('x', 0, -100, 100),
      y: number('y', 0, -100, 100),
      scale: number('scale', 1, 0.5, 1.5),
      rotate: number('rotate', 0, -180, 180)
    }
  }
  return {
    purpose: choice('purpose', ['feedback', 'continuity', 'attention']),
    trigger: choice('trigger', ['enter', 'hover', 'press', 'focus']),
    frequency: choice('frequency', ['frequent', 'occasional']),
    duration: choice('duration', ['immediate', 'feedback', 'control', 'reveal']),
    easing: choice('easing', ['ease-out', 'ease-in-out', 'linear']),
    from: state('from'),
    to: state('to')
  }
}
export function motionTargetId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/u.test(raw))
    throw new Error(
      'targetId must be a unique source element id, beginning with a letter, at most 80 characters'
    )
  return raw
}
/** CSS individual transforms preserve the element's existing transform declaration. */
export function authoredMotionCss(id: string, motion: AuthoredMotion): string {
  motionTargetId(id)
  const selector = `#${id}`
  const declaration = (s: AuthoredMotion['from']): string =>
    `opacity:${s.opacity};translate:${s.x}rem ${s.y}rem;scale:${s.scale};rotate:${s.rotate}deg;`
  const duration = MOTION_DURATIONS[motion.duration]
  const name = `cio-motion-${id}`
  if (motion.trigger === 'enter')
    return `@keyframes ${name}{from{${declaration(motion.from)}}to{${declaration(motion.to)}}}${selector}{animation:${name} ${duration}ms ${motion.easing} both;}@media(prefers-reduced-motion:reduce){${selector}{animation:none;${declaration(motion.to)}}}`
  const pseudo = { hover: ':hover', press: ':active', focus: ':focus-visible' }[motion.trigger]
  const enter = motion.frequency === 'frequent' || motion.trigger === 'press' ? 0 : duration
  return `${selector}{${declaration(motion.from)}transition-property:opacity,translate,scale,rotate;transition-duration:${duration}ms;transition-timing-function:${motion.easing};}${selector}${pseudo}{${declaration(motion.to)}transition-duration:${enter}ms;}@media(prefers-reduced-motion:reduce){${selector},${selector}${pseudo}{transition:none;translate:none;scale:1;rotate:0deg;}}`
}
