import { describe, expect, it } from 'vitest'
import {
  assignmentContinuationPrompt,
  assignmentRejectionBlock
} from '../../../src/lib/assignment/assignment-draft-continuation'

const OVERLAP =
  'Parallel tasks t4-ytd and t5-ledger-posting overlap at packages/convex-backend/src/convex/people/payrollRuns/lifecycle.ts'

describe('assignmentRejectionBlock', () => {
  it('carries nothing when no answer was refused', () => {
    expect(assignmentRejectionBlock()).toBe('')
    expect(assignmentRejectionBlock('   ')).toBe('')
  })

  it('carries the validator refusal and the fix for it', () => {
    const block = assignmentRejectionBlock(OVERLAP)
    expect(block).toContain(OVERLAP)
    expect(block).toContain('may not claim the same expected file')
  })
})

describe('assignmentContinuationPrompt', () => {
  it('asks only for the draft shape when nothing was refused', () => {
    const prompt = assignmentContinuationPrompt()
    expect(prompt).toContain('Continue the Assignment draft')
    expect(prompt).toContain('Return only one complete JSON object')
    expect(prompt).not.toContain('rejected')
  })

  it('tells the continued session what the validator refused', () => {
    const prompt = assignmentContinuationPrompt(OVERLAP)
    expect(prompt).toContain('Your previous answer was rejected')
    expect(prompt).toContain(OVERLAP)
    // The fix is stated in the validator's own terms, so the retry can actually
    // separate the two tasks instead of guessing why the graph was refused.
    expect(prompt).toContain('or make one task depend on the other')
    // The shape contract is still there: a retry must not become a conversation.
    expect(prompt).toContain('Return only one complete JSON object')
  })

  it('keeps the refusal above the shape so the model reads it first', () => {
    const prompt = assignmentContinuationPrompt(OVERLAP)
    expect(prompt.indexOf(OVERLAP)).toBeLessThan(prompt.indexOf('Return only one complete'))
  })
})
