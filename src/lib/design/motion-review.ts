export interface MotionWarning {
  rule: string
  line: number
  message: string
  severity: 'warning'
}
/** Advisory source heuristics, never a substitute for observing the running page. */
export function lintMotion(html: string): MotionWarning[] {
  const warnings: MotionWarning[] = []
  const add = (rule: string, index: number, message: string): void => {
    if (warnings.length < 50)
      warnings.push({
        rule,
        line: html.slice(0, index).split('\n').length,
        message,
        severity: 'warning'
      })
  }
  const hasMotion = /@keyframes|animation\s*:|transition\s*:|\.animate\s*\(/iu.test(html)
  if (hasMotion && !/prefers-reduced-motion/iu.test(html))
    add(
      'motion-fallback',
      0,
      'Motion detected without an explicit reduced-motion fallback. Verify behavior in the preview.'
    )
  for (const match of html.matchAll(
    /(?:transition(?:-property)?\s*:[^;{}]*(?:\ball\b|\bwidth\b|\bheight\b|\btop\b|\bleft\b)|animation[^;{}]*\binfinite\b)/giu
  ))
    add(
      'motion-cost',
      match.index!,
      'Review layout animation or a continuous loop for purpose, visibility gating and cost.'
    )
  for (const match of html.matchAll(
    /(?:animation|transition)(?:-duration)?\s*:[^;{}]*?([\d.]+)(ms|s)\b/giu
  )) {
    const ms = Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1)
    if (ms > 500)
      add(
        'motion-duration',
        match.index!,
        'Long motion may delay repeated interaction. Check context; film timing may be intentional.'
      )
  }
  return warnings
}
