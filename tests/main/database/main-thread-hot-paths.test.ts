import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guards for the stalls the durable log traced back to SQLite.
 *
 * Each one froze interaction in a shipped build: a usage insert on Electron main
 * per model response (up to 130 ms), a full-file quick_check on the worker that
 * serves clicks (18 s), and an evidence search on the interactive lane (up to
 * 1 s per keystroke). These read the source, so a change that puts any of them
 * back fails here instead of in the user's hands.
 */
function source(...parts: string[]): string {
  // Windows checkouts (autocrlf) hand back CRLF, which would break every
  // newline-anchored search below, so read source as LF on every platform.
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8').replace(/\r\n/gu, '\n')
}

function body(text: string, signature: string): string {
  const start = text.indexOf(signature)
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf('\n  }\n', start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe('main-thread SQLite hot paths', () => {
  it('records usage events on the database worker, never on Electron main', () => {
    const repo = source('main', 'database', 'repositories', 'harness-usage-repo.ts')
    for (const method of [
      'recordEvent(event: UsageEvent)',
      'recordReplacingEvent(event: UsageEvent)'
    ]) {
      const code = body(repo, method)
      expect(code).not.toMatch(/this\.db\.(run|transaction|get|all)\(/u)
      expect(code).toMatch(/ViaWorker\(/u)
    }
  })

  it('keeps the full-file quick_check off the worker that serves interactive reads', () => {
    const worker = source('main', 'database', 'database-worker-thread.ts')
    const steps = worker.slice(worker.indexOf('const MAINTENANCE_STEPS'))
    expect(steps).not.toMatch(/integrity\(/u)
    const asyncLane = source('main', 'database', 'database', 'database-async-reads.ts')
    expect(asyncLane).toMatch(/integrityCheck\(true\)/u)
  })

  it('runs every thread search read on the async lane', () => {
    const search = source('lib', 'engines', 'thread-manager-search.ts')
    const reads = search.match(/this\.db\.queryViaWorker\([^;]*\)/gsu) ?? []
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toMatch(/lane: 'async'|options\)/u)
  })

  it('hydrates the semantic matches of a search on the async lane, never synchronously', () => {
    const search = source('lib', 'engines', 'thread-manager-search.ts')
    // Hydrating the matches a search found is part of answering it, so it must
    // not join the queue a click waits in.
    const hydration = search.slice(search.indexOf('this.threadRepo.listByIdsViaWorker('))
    expect(hydration).toMatch(/lane: 'async'/u)
    // And no search statement runs on the primary connection inside a frame: the
    // fallback for a missing worker belongs to `queryViaWorker` itself.
    expect(search).not.toMatch(/this\.threadRepo\.search\(/u)
    expect(source('main', 'database', 'repositories', 'thread-repo.ts')).not.toMatch(
      /^ {2}search\(/mu
    )
  })
})
