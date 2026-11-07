import { describe, expect, it } from 'vitest'
import {
  auxiliaryCandidateKey,
  runOneShotWithCandidates
} from '../../../src/main/drivers/persistent-cli/persistent-cli-one-shot'
import { TitleTurnRegistry } from '../../../src/main/drivers/persistent-cli/persistent-cli-title'
import type {
  OneShotOutcome,
  PersistentCliSession,
  TitleModelCandidate
} from '../../../src/main/drivers/persistent-cli/persistent-cli-types'
import type { AuxiliaryCandidateVerdict } from '../../../src/main/drivers/persistent-cli/auxiliary-verdict-store'
import type { GenerateTitleOptions } from '../../../src/main/drivers/driver.interface'
import type { ThreadSettings } from '../../../src/lib/types'

/**
 * The fallback model and a cheaper sibling, matching how a pi thread offers an
 * auxiliary route: the cheap candidate goes first, the thread's own model last.
 */
const FALLBACK: TitleModelCandidate = { providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' }
const CHEAP: TitleModelCandidate = { providerId: 'opencode-go', modelId: 'beam-free' }

const SETTINGS: ThreadSettings = {
  harnessId: 'pi',
  providerId: FALLBACK.providerId,
  modelId: FALLBACK.modelId,
  thinkingLevel: 'medium',
  permissionLevel: 'auto_review'
}

const OPTIONS: GenerateTitleOptions = { settings: SETTINGS, message: 'Fix the invoice preview' }

/** What one disposable session should answer. */
interface TurnAnswer {
  text?: string
  error?: string
}

/** The model a fake session was asked to run. */
interface SentTurn {
  providerId: string | undefined
  modelId: string | undefined
}

/**
 * The smallest host `runOneShotWithCandidates` needs. Every session registers in
 * the real {@link TitleTurnRegistry}, so the run's completion wait is exercised
 * exactly as a driver exercises it, and the host records what it was asked.
 */
class FakeOneShotHost {
  readonly driverName = 'pi'
  readonly titleTurns = new TitleTurnRegistry()
  readonly quotaBlocks = new Map<string, AuxiliaryCandidateVerdict>()
  readonly sent: SentTurn[] = []
  private readonly sessions = new Map<string, PersistentCliSession>()
  private nextSession = 1

  constructor(private readonly answer: (turn: SentTurn) => TurnAnswer) {}

  async createSession(): Promise<string> {
    const id = `title-session-${this.nextSession++}`
    const now = Date.now()
    this.sessions.set(id, {
      id,
      title: 'Auxiliary one-shot',
      projectPathHash: 'p',
      messages: [],
      createdAt: now,
      updatedAt: now
    })
    return id
  }

  async sendPrompt(
    _projectPath: string,
    options: { sessionId: string; settings: ThreadSettings }
  ): Promise<void> {
    const turn: SentTurn = {
      providerId: options.settings.providerId,
      modelId: options.settings.modelId
    }
    this.sent.push(turn)
    const session = this.sessions.get(options.sessionId)
    if (!session) throw new Error(`No fake session ${options.sessionId}`)
    const answer = this.answer(turn)
    const messageId = `answer-${session.messages.length + 1}`
    session.messages.push({
      id: messageId,
      role: 'assistant',
      parts: answer.text
        ? [{ type: 'text', id: `${messageId}:text`, messageID: messageId, text: answer.text }]
        : [],
      createdAt: Date.now(),
      ...(answer.error ? { error: answer.error } : {})
    })
    this.titleTurns.intercept(
      { type: 'session.idle', sessionId: options.sessionId },
      this.driverName
    )
  }

  async requireSession(_projectPath: string, sessionId: string): Promise<PersistentCliSession> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`No fake session ${sessionId}`)
    return session
  }

  async abort(): Promise<void> {
    return undefined
  }

  async deleteSession(_projectPath: string, sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
  }
}

function run(host: FakeOneShotHost, candidates: TitleModelCandidate[]): Promise<OneShotOutcome> {
  return runOneShotWithCandidates(
    host,
    '/workspace',
    OPTIONS,
    candidates,
    'Generate a title',
    (raw) => (raw.trim() ? raw.trim() : null),
    5_000
  )
}

describe('auxiliary one-shot title runs', () => {
  it('probes the fallback model even when a stored verdict retired it', async () => {
    // The 2026-11-06 break: a six hour verdict on the thread's own model made
    // every title attempt a skip, so the run returned null in half a second and
    // the fallback title was never refined.
    const host = new FakeOneShotHost((turn) =>
      turn.modelId === FALLBACK.modelId ? { text: 'Invoice preview title' } : { error: 'unused' }
    )
    host.quotaBlocks.set(auxiliaryCandidateKey(FALLBACK), {
      resetAt: Date.now() + 6 * 60 * 60 * 1000,
      reason: 'the provider rejected this model (403: subscription required)'
    })
    host.quotaBlocks.set(auxiliaryCandidateKey(CHEAP), {
      resetAt: Date.now() + 6 * 60 * 60 * 1000,
      reason: 'model is region-locked'
    })

    const outcome = await run(host, [CHEAP, FALLBACK])

    expect(outcome.value).toBe('Invoice preview title')
    expect(host.sent.map((turn) => turn.modelId)).toEqual([FALLBACK.modelId])
    expect(host.quotaBlocks.has(auxiliaryCandidateKey(FALLBACK))).toBe(false)
  })

  it('never records a model verdict for the fallback when it is rejected as unavailable', async () => {
    const host = new FakeOneShotHost(() => ({
      error: '404: {"type":"server_error","message":"model not found"}'
    }))

    const outcome = await run(host, [FALLBACK])

    expect(outcome.value).toBeNull()
    expect(host.quotaBlocks.size).toBe(0)
  })

  it('records an account rejection against the provider, not the fallback model', async () => {
    const host = new FakeOneShotHost((turn) =>
      turn.modelId === CHEAP.modelId
        ? {
            error:
              '403: {"type":"server_error","message":"An active OpenCode Go subscription is required to use Go"}'
          }
        : { text: 'Invoice preview title' }
    )

    const outcome = await run(host, [CHEAP, FALLBACK])

    expect(outcome.value).toBe('Invoice preview title')
    expect(host.quotaBlocks.get(auxiliaryCandidateKey(CHEAP))?.reason).toContain(
      'rejected the account'
    )
    expect(host.quotaBlocks.has(auxiliaryCandidateKey(FALLBACK))).toBe(false)
  })

  it('leaves a transient overload retryable instead of parking the candidate', async () => {
    const host = new FakeOneShotHost((turn) =>
      turn.modelId === CHEAP.modelId
        ? {
            error:
              '429: {"type":"server_error","message":"Upstream request failed: [overloaded] the server is overloaded; retry shortly"}'
          }
        : { text: 'Invoice preview title' }
    )

    const outcome = await run(host, [CHEAP, FALLBACK])

    expect(outcome.value).toBe('Invoice preview title')
    expect(host.quotaBlocks.size).toBe(0)
  })

  it('takes the title from a cheaper candidate without touching the fallback', async () => {
    const host = new FakeOneShotHost(() => ({ text: 'Cheap model title' }))

    const outcome = await run(host, [CHEAP, FALLBACK])

    expect(outcome.value).toBe('Cheap model title')
    expect(host.sent.map((turn) => turn.modelId)).toEqual([CHEAP.modelId])
  })
})
