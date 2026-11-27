import { describe, expect, it } from 'vitest'
import {
  MAX_PARALLEL_PAWN_RUNS_PER_ACCOUNT,
  pawnAdmissionRefusal
} from '../../../src/main/chat/delegation/pawn-admission'

/**
 * Eleven pawns on one account is how a plan became eleven 429s.
 *
 * A provider rate limit belongs to the account, so the eleventh parallel spawn
 * cannot start; it fails before its first step. The refusal has to say why, and
 * what to do instead, or the agent will simply try again.
 */

describe('pawnAdmissionRefusal', () => {
  it('admits a spawn while the account has room', () => {
    expect(pawnAdmissionRefusal({ running: 0, harnessId: 'pi', accountId: 'cio-1' })).toBeNull()
    expect(
      pawnAdmissionRefusal({ running: MAX_PARALLEL_PAWN_RUNS_PER_ACCOUNT - 1, harnessId: 'pi' })
    ).toBeNull()
  })

  it('refuses the spawn that would exceed the account limit', () => {
    expect(
      pawnAdmissionRefusal({
        running: MAX_PARALLEL_PAWN_RUNS_PER_ACCOUNT,
        harnessId: 'pi',
        accountId: 'cio-1'
      })
    ).not.toBeNull()
  })

  it('names the account, the count and the limit so the refusal is actionable', () => {
    const refusal = pawnAdmissionRefusal({ running: 11, harnessId: 'pi', accountId: 'cio-1' })
    expect(refusal).toContain('account cio-1 on pi')
    expect(refusal).toContain('already running 11 pawn agents')
    expect(refusal).toContain(`limit is ${MAX_PARALLEL_PAWN_RUNS_PER_ACCOUNT}`)
  })

  it('tells the agent to spread the work across accounts instead of retrying blindly', () => {
    const refusal = pawnAdmissionRefusal({ running: 4, harnessId: 'pi', accountId: 'cio-1' })
    expect(refusal).toContain('account_id')
    expect(refusal).toContain('Nothing was spawned')
  })

  it('honours an explicit limit', () => {
    expect(pawnAdmissionRefusal({ running: 2, harnessId: 'pi', limit: 5 })).toBeNull()
    expect(pawnAdmissionRefusal({ running: 5, harnessId: 'pi', limit: 5 })).not.toBeNull()
  })
})
