export const DESIGN_REVIEW_DIMENSIONS = [
  'philosophy',
  'hierarchy',
  'detail',
  'functionality',
  'innovation'
] as const
export const DESIGN_REVIEW_RUBRIC = 'design-v1'
export const DESIGN_REVIEW_THRESHOLD = 8
export type DesignReviewDimension = (typeof DESIGN_REVIEW_DIMENSIONS)[number]
export interface DesignReviewAssessment {
  score: number
  evidence: string
}
export interface DesignCraftFinding {
  rule: string
  line: number
  message: string
}
export interface DesignCraftReport {
  hash: string
  findings: DesignCraftFinding[]
  motionWarnings?: import('./motion-review').MotionWarning[]
}
export interface DesignModelRanking {
  harness: string
  provider: string
  model: string
  samples: number
  score: number
}

/** Objective markup checks. Visual judgment stays in the single-pass critique. */
export function lintDesignCraft(html: string): DesignCraftFinding[] {
  const findings: DesignCraftFinding[] = []
  const add = (rule: string, index: number, message: string): void => {
    if (findings.length >= 100) return
    findings.push({ rule, line: html.slice(0, index).split('\n').length, message })
  }
  const patterns = [
    {
      rule: 'scalable-type',
      regex: /font-size\s*:\s*[\d.]+px\b|text-\[[\d.]+px\]/giu,
      message: 'Use rem for font sizes.'
    },
    {
      rule: 'switch-controls',
      regex:
        /<[a-z][a-z0-9-]*\b[^>]*(?:type\s*=\s*["']checkbox["']|role\s*=\s*["']checkbox["'])[^>]*>/giu,
      message: 'Use a switch control instead of checkbox semantics.'
    },
    {
      rule: 'real-copy',
      regex: /\b(?:lorem ipsum|your (?:title|headline|text) here)\b/giu,
      message: 'Replace placeholder copy with product content.'
    },
    {
      rule: 'focus-visible',
      regex: /(?:outline\s*:\s*(?:none|0)|outline-none)\b/giu,
      message: 'Verify that removing the outline has an equivalent visible focus ring.'
    }
  ]
  for (const rule of patterns) {
    if (
      rule.rule === 'focus-visible' &&
      /:focus|focus(?:-visible)?:[\w-]*(?:ring|outline|border)/iu.test(html)
    )
      continue
    for (const match of html.matchAll(rule.regex)) add(rule.rule, match.index!, rule.message)
  }
  for (const match of html.matchAll(/<img\b[^>]*>/giu))
    if (!/\balt\s*=/iu.test(match[0]))
      add('image-alt', match.index!, 'Provide alt text, or an empty alt for decorative images.')
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/giu)) {
    const text = match[2]!
      .replace(/<svg\b[\s\S]*?<\/svg>/giu, '')
      .replace(/<[^>]*>/gu, '')
      .trim()
    if (!text && (!/\baria-label\s*=/iu.test(match[1]!) || !/\btitle\s*=/iu.test(match[1]!)))
      add(
        'icon-button-name',
        match.index!,
        'An icon-only button needs an action-specific title and aria-label.'
      )
  }
  return findings
}
