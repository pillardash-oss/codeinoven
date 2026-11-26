import { describe, expect, it, vi } from 'vitest'
import {
  DELEGATION_REPORT_GRACE_MS,
  DELEGATION_REPORT_RETRY_HORIZON_MS,
  awaitDelegationOutcome,
  delegationRetryIsImminent
} from '../../../src/main/chat/delegation/delegation-report-grace'

/**
 * A delegated run that fails is not reported the moment it fails.
 *
 * The app retries a provider failure by parking the thread on `working-paused`,
 * and that retry is usually over long before a person could read a report. These
 * lock in the rule that decides whether an outcome is worth telling the parent
 * about, without waiting a real minute for each case.
 */

const noSleep = async (): Promise<void> => undefined

const now = Date.now()

describe('awaitDelegationOutcome', () => {
  it('reports a completed run at once and never re-reads it', async () => {
    const read = vi.fn(async () => 'failed' as const)
    await expect(awaitDelegationOutcome('completed', read, { sleep: noSleep })).resolves.toEqual({
      report: true,
      status: 'completed'
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('waits the grace window before reading the run again', async () => {
    const sleep = vi.fn(async () => undefined)
    await awaitDelegationOutcome('failed', async () => 'failed', { sleep })
    expect(sleep).toHaveBeenCalledWith(DELEGATION_REPORT_GRACE_MS)
  })

  it('stays silent while a retry owns the run', async () => {
    await expect(
      awaitDelegationOutcome('failed', async () => 'working-paused', { sleep: noSleep })
    ).resolves.toEqual({ report: false, status: 'working-paused' })
  })

  it('stays silent while the run is working again', async () => {
    await expect(
      awaitDelegationOutcome('failed', async () => 'executing', { sleep: noSleep })
    ).resolves.toEqual({ report: false, status: 'executing' })
  })

  it('reports the recovered status when the retry finished in the window', async () => {
    await expect(
      awaitDelegationOutcome('failed', async () => 'completed', { sleep: noSleep })
    ).resolves.toEqual({ report: true, status: 'completed' })
  })

  it('reports a run that is still failed after the window', async () => {
    await expect(
      awaitDelegationOutcome('failed', async () => 'failed', { sleep: noSleep })
    ).resolves.toEqual({ report: true, status: 'failed' })
  })

  it('reports the status it had when the thread disappeared while waiting', async () => {
    await expect(
      awaitDelegationOutcome('interrupted', async () => null, { sleep: noSleep })
    ).resolves.toEqual({ report: true, status: 'interrupted' })
  })

  it('stays silent while a retry for the run arrives in moments', async () => {
    await expect(
      awaitDelegationOutcome('failed', async () => 'failed', {
        sleep: noSleep,
        retryAt: () => now + 30_000
      })
    ).resolves.toEqual({ report: false, status: 'failed' })
  })

  it('reports a run parked on a retry that is days away', async () => {
    await expect(
      awaitDelegationOutcome('working-paused', async () => 'working-paused', {
        sleep: noSleep,
        retryAt: () => Date.now() + 20 * 24 * 60 * 60_000
      })
    ).resolves.toEqual({ report: true, status: 'working-paused' })
  })

  it('reports a failed run once its retry is no longer imminent', async () => {
    await expect(
      awaitDelegationOutcome('failed', async () => 'failed', {
        sleep: noSleep,
        retryAt: () => now + 20 * 24 * 60 * 60_000
      })
    ).resolves.toEqual({ report: true, status: 'failed' })
  })
})

describe('delegationRetryIsImminent', () => {
  const fixedNow = Date.UTC(2026, 10, 26, 14, 0, 0)

  it('waits for a retry that is seconds away', () => {
    expect(delegationRetryIsImminent(fixedNow + 30_000, fixedNow)).toBe(true)
  })

  it('waits for a retry at the edge of the horizon', () => {
    expect(delegationRetryIsImminent(fixedNow + DELEGATION_REPORT_RETRY_HORIZON_MS, fixedNow)).toBe(
      true
    )
  })

  it('reports a usage reset that is days away instead of waiting for it', () => {
    expect(delegationRetryIsImminent(fixedNow + 20 * 24 * 60 * 60_000, fixedNow)).toBe(false)
  })
})
