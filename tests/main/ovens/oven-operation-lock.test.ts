import { describe, expect, it } from 'vitest'
import { beginOvenHarnessRun, withOvenHarnessMutation } from '../../../src/main/ovens/oven-operation-lock'

describe('oven harness operation gate', () => {
  it('blocks new runs while a harness mutation is in progress', async () => {
    let finishMutation = (): void => undefined
    const mutation = withOvenHarnessMutation('oven-a', 'codex', () =>
      new Promise<void>((resolve) => {
        finishMutation = resolve
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(() => beginOvenHarnessRun('oven-a', 'codex')).toThrow('being updated')
    finishMutation()
    await mutation
    const release = beginOvenHarnessRun('oven-a', 'codex')
    expect(release).toBeTypeOf('function')
    release()
  })

  it('allows a mutation to proceed after an admitted start request settles', async () => {
    const releaseStart = beginOvenHarnessRun('oven-b', 'claude')
    let finished = false
    const mutation = withOvenHarnessMutation('oven-b', 'claude', async () => {
      finished = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(finished).toBe(false)
    releaseStart()
    await mutation
    expect(finished).toBe(true)
  })
})
