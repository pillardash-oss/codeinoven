import { describe, expect, it, vi } from 'vitest'
import {
  DELEGATION_REPORT_DELIVERY_ATTEMPTS,
  DELEGATION_REPORT_DELIVERY_DELAY_MS,
  deliverDelegationReport
} from '../../../src/main/chat/delegation/delegation-report-delivery'

/**
 * A finished delegated run always gets its report filed.
 *
 * A pawn's report is the only thing that tells the agent that spawned it the
 * work is done. The first attempt can lose its race with a session that is
 * already settling   the old process is gone while the thread's row still says
 * working   and the app used to log that away and move on, so the parent sat
 * waiting for a message nobody would ever send. These lock in the retry that
 * replaced it.
 */

const noSleep = async (): Promise<void> => undefined

describe('deliverDelegationReport', () => {
  it('delivers on the first attempt without waiting', async () => {
    const send = vi.fn(async () => 'delivered')
    const sleep = vi.fn(noSleep)
    await expect(deliverDelegationReport(send, { sleep })).resolves.toBe('delivered')
    expect(send).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('retries a report that lost its race and delivers it', async () => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('No active Claude Code turn is available to steer'))
      .mockRejectedValueOnce(new Error('the session is still settling'))
      .mockResolvedValue('delivered')
    const sleep = vi.fn(noSleep)
    await expect(deliverDelegationReport(send, { sleep })).resolves.toBe('delivered')
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('backs off between attempts so a settling turn is not hammered', async () => {
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('busy'))
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue('delivered')
    const sleep = vi.fn<(ms: number) => Promise<void>>(noSleep)
    await deliverDelegationReport(send, { sleep })
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
      DELEGATION_REPORT_DELIVERY_DELAY_MS,
      DELEGATION_REPORT_DELIVERY_DELAY_MS * 2
    ])
  })

  it('throws the last failure once every attempt is spent', async () => {
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('still no turn'))
    await expect(deliverDelegationReport(send, { sleep: noSleep })).rejects.toThrow('still no turn')
    expect(send).toHaveBeenCalledTimes(DELEGATION_REPORT_DELIVERY_ATTEMPTS)
  })

  it('names every failed attempt to the caller', async () => {
    const failures: number[] = []
    const send = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('one'))
      .mockResolvedValue('delivered')
    await deliverDelegationReport(send, {
      sleep: noSleep,
      onFailure: (_error, attempt) => failures.push(attempt)
    })
    expect(failures).toEqual([1])
  })
})
