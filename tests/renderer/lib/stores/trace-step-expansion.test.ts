import { beforeEach, describe, expect, it } from 'vitest'

import { traceStepExpansion, traceStepScope } from '$lib/stores/trace-step-expansion.svelte'

const SCOPE = traceStepScope('p1', 't1')

beforeEach(() => {
  traceStepExpansion.forgetScope(SCOPE)
  traceStepExpansion.forgetScope(traceStepScope('p1', 't2'))
})

describe('trace step expansion', () => {
  it('starts folded for every step', () => {
    expect(traceStepExpansion.isOpen(SCOPE, 'rea-1')).toBe(false)
  })

  it('remembers a step the reader opened, for any later mount of that row', () => {
    // The row is destroyed and re-created whenever the trace re-mounts it   a
    // chain folding on its output, the trace closing at a step boundary, an
    // older page arriving. The reader's open has to outlive the row.
    traceStepExpansion.setOpen(SCOPE, 'tool-1', true)

    expect(traceStepExpansion.isOpen(SCOPE, 'tool-1')).toBe(true)
  })

  it('forgets it when the reader closes it', () => {
    traceStepExpansion.setOpen(SCOPE, 'tool-1', true)
    traceStepExpansion.setOpen(SCOPE, 'tool-1', false)

    expect(traceStepExpansion.isOpen(SCOPE, 'tool-1')).toBe(false)
  })

  it('keeps conversations apart', () => {
    traceStepExpansion.setOpen(SCOPE, 'tool-1', true)

    expect(traceStepExpansion.isOpen(traceStepScope('p1', 't2'), 'tool-1')).toBe(false)
  })

  it('forgets a thread when it is left, and only that thread', () => {
    const other = traceStepScope('p1', 't2')
    traceStepExpansion.setOpen(SCOPE, 'tool-1', true)
    traceStepExpansion.setOpen(SCOPE, 'rea-1', true)
    traceStepExpansion.setOpen(other, 'tool-1', true)

    traceStepExpansion.forgetScope(SCOPE)

    expect(traceStepExpansion.isOpen(SCOPE, 'tool-1')).toBe(false)
    expect(traceStepExpansion.isOpen(SCOPE, 'rea-1')).toBe(false)
    expect(traceStepExpansion.isOpen(other, 'tool-1')).toBe(true)
  })
})
