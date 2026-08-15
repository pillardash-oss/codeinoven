import { describe, expect, it } from 'vitest'
import { createAutoTitleLauncher } from '../../src/main/chat/title-generation-policy'

describe('thread title generation scheduling', () => {
  it('launches independently and exactly once', async () => {
    let calls = 0
    const launch = createAutoTitleLauncher(true, async () => {
      calls += 1
    })

    await Promise.all([launch(), launch(), launch()])

    expect(calls).toBe(1)
  })

  it('does not launch when the thread already has a title', async () => {
    let calls = 0
    const launch = createAutoTitleLauncher(false, async () => {
      calls += 1
    })

    await launch()

    expect(calls).toBe(0)
  })
})
