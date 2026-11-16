import { describe, expect, it } from 'vitest'

import { fitSnapshot } from '../../../src/main/browser/browser-service/browser-agent-snapshot-fit'

const element = (ref: string, visible = true) => ({
  ref,
  selector: `#field-${ref}-${'x'.repeat(40)}`,
  tag: 'input',
  role: '',
  label: `Field ${ref}`,
  visible,
  box: { x: 1, y: 2, width: 3, height: 4 }
})

describe('fitSnapshot', () => {
  it('returns a snapshot that already fits untouched', () => {
    const input = { title: 't', elements: [element('r1')], frames: [] }
    expect(fitSnapshot(input, 10_000)).toEqual({ snapshot: input, omitted: null })
  })

  it('keeps every frame control and trims prose when a portal page is too large', () => {
    const input = {
      title: 'Portal',
      text: 'a'.repeat(20_000),
      elements: [element('r1'), element('f2r1'), element('f2r2')],
      frames: [{ frame: 2, text: 'b'.repeat(4_000) }]
    }
    const { snapshot, omitted } = fitSnapshot(input, 6_000)
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(6_000)
    expect((snapshot['elements'] as { ref: string }[]).map((item) => item.ref)).toEqual([
      'r1',
      'f2r1',
      'f2r2'
    ])
    expect(omitted?.text).toBeGreaterThan(0)
    expect(omitted?.elements).toBeUndefined()
  })

  it('drops hidden elements before visible ones', () => {
    const elements = Array.from({ length: 200 }, (_, index) =>
      element(`r${index}`, index % 2 === 0)
    )
    const { snapshot, omitted } = fitSnapshot({ elements, frames: [] }, 4_000)
    const kept = snapshot['elements'] as { visible?: boolean }[]
    expect(JSON.stringify(snapshot).length).toBeLessThanOrEqual(4_000)
    expect(kept.every((item) => item.visible !== false)).toBe(true)
    expect(omitted?.elements).toBe(200 - kept.length)
  })
})
