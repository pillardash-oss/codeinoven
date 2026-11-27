import { describe, expect, it } from 'vitest'
import { waterFillHeights } from '../../../src/renderer/lib/git-changes-layout'

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0)

describe('waterFillHeights', () => {
  it('lets a short section hug its content and gives the rest to the long one', () => {
    // 100 files against 6, in a column that fits far more than the six need.
    expect(waterFillHeights(700, [2400, 220])).toEqual([480, 220])
  })

  it('splits equally once every section wants more than its share', () => {
    expect(waterFillHeights(900, [2400, 2400])).toEqual([450, 450])
    expect(waterFillHeights(900, [2400, 2400, 2400])).toEqual([300, 300, 300])
  })

  it('gives a section only what it asked for when it is smaller than a fair share', () => {
    // Two empty sections leave everything to the one with content.
    expect(waterFillHeights(600, [0, 0, 1800])).toEqual([0, 0, 600])
  })

  it('redistributes when a section is short but not empty', () => {
    // Fair share is 250: the 100 one fits, the other two split what is left.
    expect(waterFillHeights(500, [100, 900, 900])).toEqual([100, 200, 200])
  })

  it('gives the height nobody asked for to the section with the most content', () => {
    // A column of short sections still fills: the slack lands where it buys the
    // most rows, so a lone section fills the panel instead of sitting in a corner.
    expect(waterFillHeights(800, [180, 60])).toEqual([740, 60])
    expect(waterFillHeights(500, [252])).toEqual([500])
    expect(sum(waterFillHeights(800, [180, 60]))).toBe(800)
  })

  it('never takes the slack from a section that is already full', () => {
    // Both full: the split is the water fill's, unchanged.
    expect(waterFillHeights(900, [2400, 2400])).toEqual([450, 450])
  })

  it('returns nothing to show for an empty column', () => {
    expect(waterFillHeights(0, [100, 200])).toEqual([0, 0])
    expect(waterFillHeights(500, [])).toEqual([])
  })
})
