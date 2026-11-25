/**
 * The daily integrity probe must not run while a person is working.
 *
 * The probe is `PRAGMA quick_check`: it reads every page of the database, which
 * on this install is a 1.25 GB file and eight to twelve seconds of CPU and disk.
 * Its own worker keeps it off the click path, which is not the same as free, so
 * the gate these tests cover holds it back until no window is in use and the
 * database has been silent for a quiet window — and runs it anyway once the
 * bounded wait expires, because noticing corruption matters more than the cost.
 *
 * The worker is a typed double rather than a real thread: the subject here is the
 * schedule and the gate, not SQLite.
 */

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import { DatabaseAsyncReads } from '../../../src/main/database/database/database-async-reads'
import type {
  DatabaseWorkerOutbound,
  DatabaseWorkerRequest,
  DatabaseWorkerResult,
  DatabaseWorkerFactory
} from '../../../src/main/database/database-worker'
import { Logger } from '../../../src/main/system/logger'

/** A worker_threads stand-in that answers every request synchronously-ish. */
class FakeWorkerThread extends EventEmitter {
  readonly posted: DatabaseWorkerRequest[] = []
  /** What the next `integrity` request answers with. */
  integrityOk = true

  postMessage(message: DatabaseWorkerOutbound): void {
    this.posted.push(message.request)
    const answer: DatabaseWorkerResult = this.resultFor(message.request)
    setImmediate(() => {
      this.emit('message', { type: 'response', id: message.id, result: answer })
      if (message.request.kind === 'shutdown') this.emit('exit', 0)
    })
  }

  async terminate(): Promise<number> {
    return 0
  }

  private resultFor(request: DatabaseWorkerRequest): DatabaseWorkerResult {
    if (request.kind === 'shutdown') return { kind: 'shutdown', ok: true }
    if (request.kind === 'integrity') {
      return this.integrityOk
        ? { kind: 'integrity', ok: true, text: 'ok' }
        : { kind: 'integrity', ok: false, text: 'corrupt', error: 'corrupt page' }
    }
    return { kind: 'ping', ok: true }
  }
}

function fakeWorkerFactory(worker: FakeWorkerThread): DatabaseWorkerFactory {
  // One cast at the test boundary: the double implements exactly the surface the
  // worker wrapper uses (message/exit events, postMessage, terminate).
  return (_options: WorkerOptions) => worker as unknown as Worker
}

function integrityProbes(worker: FakeWorkerThread): number {
  return worker.posted.filter((request) => request.kind === 'integrity').length
}

/** Resolve once `count` probes have been posted, plus one turn for the answer. */
function waitForProbe(worker: FakeWorkerThread, count = 1, timeoutMs = 5_000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now()
    const poll = setInterval(() => {
      if (integrityProbes(worker) >= count) {
        clearInterval(poll)
        setTimeout(resolve, 25)
        return
      }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(poll)
        reject(new Error(`expected ${count} integrity probe(s) within ${timeoutMs} ms`))
      }
    }, 10)
  })
}

const running: DatabaseAsyncReads[] = []

function lane(
  worker: FakeWorkerThread,
  options: ConstructorParameters<typeof DatabaseAsyncReads>[2]
): DatabaseAsyncReads {
  const reads = new DatabaseAsyncReads(join('app.db'), fakeWorkerFactory(worker), options)
  running.push(reads)
  return reads
}

afterEach(async () => {
  for (const reads of running.splice(0)) await reads.stop()
})

describe('async lane integrity probe', () => {
  it('holds the probe while a window is in use and runs it once the user leaves', async () => {
    const worker = new FakeWorkerThread()
    let userActive = true
    const reads = lane(worker, {
      firstDelayMs: 5,
      quietMs: 10,
      maxWaitMs: 4_000,
      pollMs: 10,
      isUserActive: () => userActive
    })
    const logSpy = vi.spyOn(Logger, 'info')
    reads.start()

    // The probe is due immediately, but the user is working: nothing runs.
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(integrityProbes(worker)).toBe(0)

    userActive = false
    await waitForProbe(worker)
    expect(integrityProbes(worker)).toBe(1)
    // The outcome is unchanged: the same line the app always logged.
    expect(logSpy).toHaveBeenCalledWith('Database maintenance: quick_check: ok')
    logSpy.mockRestore()
  })

  it('waits for the database to go quiet, not only for the user to leave', async () => {
    const worker = new FakeWorkerThread()
    const quietChecks: Array<{ quietMs: number; deadlineMs: number }> = []
    const reads = lane(worker, {
      firstDelayMs: 5,
      quietMs: 40,
      maxWaitMs: 4_000,
      isUserActive: () => false,
      waitForDatabaseQuiet: (quietMs, deadlineMs) => {
        quietChecks.push({ quietMs, deadlineMs })
        return new Promise((resolve) => setTimeout(resolve, 30))
      }
    })
    reads.start()

    await waitForProbe(worker)
    expect(quietChecks.length).toBeGreaterThan(0)
    expect(quietChecks[0]?.quietMs).toBeGreaterThan(0)
    expect(quietChecks[0]?.deadlineMs).toBeGreaterThan(0)
  })

  it('probes anyway when the app is never quiet, on a bounded delay', async () => {
    const worker = new FakeWorkerThread()
    const reads = lane(worker, {
      firstDelayMs: 5,
      quietMs: 20,
      maxWaitMs: 200,
      pollMs: 10,
      isUserActive: () => true
    })
    reads.start()

    // The user never leaves, so the budget — not the quiet window — is what ends
    // the wait. The probe must still happen: corruption is only found here.
    await waitForProbe(worker, 1, 3_000)
    expect(integrityProbes(worker)).toBe(1)
  })

  it('re-arms after a probe and reports a failed check as an error', async () => {
    const worker = new FakeWorkerThread()
    worker.integrityOk = false
    const reads = lane(worker, {
      firstDelayMs: 5,
      intervalMs: 40,
      quietMs: 5,
      maxWaitMs: 1_000,
      isUserActive: () => false
    })
    const errorSpy = vi.spyOn(Logger, 'error')
    reads.start()

    // Two probes prove the schedule re-armed in `finally`, and each one logged
    // through the error channel exactly as before.
    await waitForProbe(worker, 2, 3_000)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(errorSpy).toHaveBeenCalledWith(
      'Database maintenance: quick_check failed',
      expect.stringContaining('corrupt')
    )
    errorSpy.mockRestore()
  })

  it('gives up waiting when the lane is stopped mid-wait', async () => {
    const worker = new FakeWorkerThread()
    const reads = lane(worker, {
      firstDelayMs: 5,
      quietMs: 20,
      maxWaitMs: 5_000,
      pollMs: 10,
      isUserActive: () => true
    })
    reads.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    await reads.stop()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(integrityProbes(worker)).toBe(0)
    expect(worker.posted.some((request) => request.kind === 'shutdown')).toBe(true)
  })
})
