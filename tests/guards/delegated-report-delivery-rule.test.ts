import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A delegated run's finish always reaches the agent that asked for it.
 *
 * Three separate breaks in that promise were all shipped once:
 *
 * - a message that arrived between a turn's process exiting and the thread's
 *   idle event was handed to the harness as a steer, which threw "no active
 *   turn to steer", failed the whole dispatch and dropped the message   a pawn
 *   report died exactly there;
 * - a pawn whose provider error had a retry already scheduled was reported as
 *   failed, so nothing was left watching the run that then finished;
 * - a steer that rebuilt its utility turn tore down the runtime overlay of an
 *   MCP-runtime harness and returned without applying a new one, leaving that
 *   session with no app tools for the rest of the turn.
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
    // The steer branch must be gated on the live-turn answer, not on the row's
    // status alone: a status that has not caught up is the window that lost them.
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

  it('keeps following a pawn whose retry is still queued instead of reporting it dead', async () => {
    const pawns = await readSource(
      'src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns.ts'
    )
    expect(pawns).toContain('pawnRetryPending')
    expect(pawns).toContain('retryScheduler?.getPendingRetry(sessionId)')
    // Both the background follow and the inline wait must consult the retry.
    expect(
      pawns.match(/isRetryPending: \(\) => this\.pawnRetryPending\(sessionId\)/g)
    ).toHaveLength(2)
  })

  it('retries a pawn report instead of logging a lost one', async () => {
    const pawns = await readSource(
      'src/main/chat/chat-engine/chat-engine-assignment-workers/chat-engine-assignment-workers-pawns.ts'
    )
    expect(pawns).toContain('deliverDelegationReport')
    expect(pawns).toMatch(/await deliverDelegationReport\(\(\) =>\s*this\.host\.sendPrompt\(/)
  })

  it('retries a dispatched run report too', async () => {
    const dispatch = await readSource('src/main/chat/chat-engine/chat-engine-turns-dispatch.ts')
    expect(dispatch).toContain('deliverDelegationReport')
    expect(dispatch).toContain('isRetryPending')
  })

  it('re-applies the MCP runtime overlay when a steer rebuilds its utility turn', async () => {
    const utilities = await readSource('src/main/chat/chat-engine/chat-engine-utilities.ts')
    expect(utilities).toContain('applyPreparedUtilityRuntime?.bind(driver)')
    expect(utilities).toContain('driver.prepareUtilityRuntime?.(request)')
    expect(utilities).toMatch(/await applyRuntime\(projectPath, runtime, sessionId\)/)
    // A harness with no endpoint and no runtime overlay cannot carry the
    // gateway, so a steer may leave it alone; every other harness must re-arm.
    expect(utilities).toContain('if (!publishUtilityEndpoint && !applyRuntime) return')
  })
})
