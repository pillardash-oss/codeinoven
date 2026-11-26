import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A delegated run's finish always reaches the agent that asked for it, and it
 * never costs that agent the turn it is running.
 *
 * Ten pawns were sent through one account and every one of them stopped on a
 * 429. Their ten reports then landed on the parent together, and the parent's
 * session was handed ten prompts as steers: each one killed the turn it joined
 * (Claude Code exits 143), the ones that lost the race marked the parent thread
 * failed, and the app showed a wall of errors with none of the news. The rules
 * below are what replaced that:
 *
 * - a report never steers a live turn; it is delivered as the next turn;
 * - a report waits in a durable, per-parent queue and is delivered when that
 *   parent is free, in order, batched;
 * - a steer only happens when the driver really holds a live turn;
 * - a provider retry days away is reported now, not waited for.
 *
 * These are read from source because each one is a rule about ordering inside a
 * large dispatch, not a return value a unit test can call.
 */

const projectRoot = join(import.meta.dirname, '..', '..')

async function readSource(relativePath: string): Promise<string> {
  return readFile(join(projectRoot, relativePath), 'utf8')
}

describe('delegated report delivery', () => {
  it('never steers a session whose harness reports no live turn', async () => {
    const sendPrompt = await readSource(
      'src/main/chat/chat-engine/chat-engine-turns-send-prompt.ts'
    )
    expect(sendPrompt).toContain('driverReportsLiveTurn')
    expect(sendPrompt).toContain('driver.hasActiveTurn(sessionId)')
    expect(sendPrompt).toContain('turnIsLive')
    // A forced next turn must bypass the steer branch outright.
    expect(sendPrompt).toMatch(/!deliverAsNewTurn &&/)
    expect(sendPrompt).toMatch(
      /if \(\(activeSessionState === 'working' \|\| activeSessionState === 'waiting'\) && turnIsLive\)/
    )
  })

  it('lets a one-process-per-turn harness answer for its own live turn', async () => {
    const driver = await readSource('src/main/drivers/persistent-cli-driver.ts')
    expect(driver).toMatch(/hasActiveTurn\(sessionId: string\): boolean \{/)
    expect(driver).toContain('this.activeProcesses.get(sessionId)')
    expect(driver).toContain('this.steeringSessions.has(sessionId)')
  })

  it('delivers a pawn report through the queue, never straight into the spawner', async () => {
    const pawns = await readSource(
      'src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns.ts'
    )
    expect(pawns).toContain("this.host.units['delegation-reports'].enqueue({")
    expect(pawns).toContain("kind: 'pawn'")
    // The report itself must not reach into the spawner's session: a steer
    // there kills the turn it joins on a one-process-per-turn harness.
    const report = pawns.slice(pawns.indexOf('async reportPawnCompletion'))
    expect(report).not.toContain('this.host.sendPrompt(')
  })

  it('delivers a dispatched run report through the queue too', async () => {
    const dispatch = await readSource('src/main/chat/chat-engine/chat-engine-turns-dispatch.ts')
    expect(dispatch).toContain("this.host.units['delegation-reports'].enqueue({")
    expect(dispatch).not.toContain('deliverDelegationReport')
  })

  it("delivers a queued batch as the parent's next turn, gated on an idle thread", async () => {
    const queue = await readSource('src/main/chat/chat-engine/chat-engine-delegation-reports.ts')
    expect(queue).toContain('isThreadBusyStatus(thread.status)')
    expect(queue).toContain("sessionState === 'working' || sessionState === 'waiting'")
    // The trailing flag is what forbids a steer for a report.
    expect(queue).toMatch(
      /'internal',\s*\{ action: turn\.action, body: turn\.body \},\s*undefined,\s*false,\s*true/
    )
    // A delivery that throws keeps the reports for the next attempt.
    expect(queue).toContain('A queued delegated report could not be delivered')
  })

  it('drains the report queue when a parent goes idle, so news is never stranded', async () => {
    const idle = await readSource('src/main/chat/chat-engine/chat-engine-turns-session-idle.ts')
    expect(idle).toContain("this.host.units['delegation-reports'].drain(")
  })

  it('restores waiting report queues at launch', async () => {
    const boot = await readSource('src/main/chat/chat-engine/chat-engine-lifecycle-boot.ts')
    expect(boot).toContain("this.host.units['delegation-reports'].restoreQueues()")
  })

  it('refuses a pawn spawn that would saturate one account', async () => {
    const pawns = await readSource(
      'src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns.ts'
    )
    // The refusal must run before the thread is created, so a saturated account
    // costs one tool call instead of a failed run the user has to clean up.
    expect(pawns).toContain('await this.refuseWhenAccountSaturated(settings)')
    expect(pawns.indexOf('await this.refuseWhenAccountSaturated(settings)')).toBeLessThan(
      pawns.lastIndexOf('this.host.threadManager.createThread({')
    )
    expect(pawns).toContain('pawnAdmissionRefusal')
    expect(pawns).toContain('assignment_id IS NULL')
  })

  it('reports a retry that is days away instead of waiting for it', async () => {
    const grace = await readSource('src/main/chat/delegation/delegation-report-grace.ts')
    expect(grace).toContain('DELEGATION_REPORT_RETRY_HORIZON_MS')
    expect(grace).toContain('delegationRetryIsImminent')
    const pawns = await readSource(
      'src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns.ts'
    )
    expect(pawns).toContain('pawnRetryAt')
    expect(pawns).toContain('retryAt: () => this.pawnRetryAt(sessionId)')
  })

  it('re-applies the MCP runtime overlay when a steer rebuilds its utility turn', async () => {
    const utilities = await readSource('src/main/chat/chat-engine/chat-engine-utilities.ts')
    expect(utilities).toContain('applyPreparedUtilityRuntime?.bind(driver)')
    expect(utilities).toContain('driver.prepareUtilityRuntime?.(request)')
    expect(utilities).toMatch(/await applyRuntime\(projectPath, runtime, sessionId\)/)
    expect(utilities).toContain('if (!publishUtilityEndpoint && !applyRuntime) return')
  })
})
