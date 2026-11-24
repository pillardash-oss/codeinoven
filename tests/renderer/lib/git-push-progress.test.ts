import { describe, expect, it } from 'vitest'
import type { GitPushProgress } from '../../../src/lib/types'
import { pushPercent } from '../../../src/renderer/lib/components/git/git-push-progress'

function progress(stage: string, percent: number): GitPushProgress {
  return { projectId: 'project-1', stage, percent, processed: 0, total: 0 }
}

describe('pushPercent', () => {
  it('keeps one push counting up instead of restarting at each stage', () => {
    // git reports these three stages on their own scales in a single push, so
    // the button must never read 100, 0, 100, 0, 100 for a healthy push.
    expect(pushPercent(progress('counting', 0))).toBe(0)
    expect(pushPercent(progress('counting', 100))).toBe(8)
    expect(pushPercent(progress('compressing', 0))).toBe(8)
    expect(pushPercent(progress('compressing', 100))).toBe(30)
    expect(pushPercent(progress('writing', 0))).toBe(30)
    expect(pushPercent(progress('writing', 100))).toBe(100)
  })

  it('never goes backwards across the stages git reports in order', () => {
    const reported: GitPushProgress[] = [
      progress('counting', 100),
      progress('compressing', 45),
      progress('compressing', 100),
      progress('writing', 3),
      progress('writing', 99),
      progress('writing', 100)
    ]
    const seen = reported.map(pushPercent)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  it('passes an unknown stage through instead of inventing a band', () => {
    expect(pushPercent(progress('receiving', 62))).toBe(62)
  })

  it('clamps a percentage git reports outside its own range', () => {
    expect(pushPercent(progress('writing', 140))).toBe(100)
    expect(pushPercent(progress('writing', -5))).toBe(30)
  })
})
