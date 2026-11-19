import { beforeEach, describe, expect, it } from 'vitest'
import type { OvenRun, OvenRunEvent, StartOvenRunInput } from '../../../src/lib/ovens'
import type { OvenService } from '../../../src/main/ovens/oven-service'
import {
  forgetOvenAccountUsage,
  ovenAccountUsage,
  readOvenAccountUsage
} from '../../../src/main/ovens/oven-account-usage'

/**
 * A stand-in for one Oven's run channel.
 *
 * It journals stdout the way the service does and answers a harness's own
 * request with the payload that harness would send, so a probe is exercised
 * through the same start/write/events/remove path the real service uses.
 */
class FakeOvenService {
  readonly runs = new Map<string, OvenRun>()
  readonly starts: StartOvenRunInput[] = []
  readonly removals: string[] = []
  private readonly journals = new Map<string, OvenRunEvent[]>()

  constructor(private readonly answer: (input: string) => string[]) {}

  private append(runId: string, text: string): void {
    const journal = this.journals.get(runId) ?? []
    journal.push({ sequence: journal.length + 1, stream: 'stdout', text })
    this.journals.set(runId, journal)
  }

  async start(_ovenId: string, input: StartOvenRunInput): Promise<OvenRun> {
    this.starts.push(input)
    const run: OvenRun = {
      id: input.id,
      command: input.command,
      cwd: input.cwd,
      status: 'running',
      createdAt: Date.now()
    }
    this.runs.set(input.id, run)
    this.journals.set(input.id, [])
    return run
  }

  async events(
    _ovenId: string,
    runId: string,
    after: number
  ): Promise<{ run: OvenRun; events: OvenRunEvent[] }> {
    const run = this.runs.get(runId)
    if (!run) throw new Error('The remote run does not exist.')
    return {
      run,
      events: (this.journals.get(runId) ?? []).filter((event) => event.sequence > after)
    }
  }

  async write(_ovenId: string, runId: string, input: string): Promise<void> {
    for (const text of this.answer(input)) this.append(runId, text)
  }

  async stop(_ovenId: string, runId: string): Promise<void> {
    const run = this.runs.get(runId)
    if (run) run.status = 'stopped'
  }

  async remove(_ovenId: string, runId: string): Promise<void> {
    this.removals.push(runId)
    this.runs.delete(runId)
  }
}

const codexTarget = {
  ovenId: 'oven-one',
  harnessId: 'codex',
  providerId: 'openai',
  accountId: 'codex-account',
  cwd: '/home/oven/.local/share/codeinoven/accounts/codex-account',
  environment: { CODEX_HOME: '/home/oven/.local/share/codeinoven/accounts/codex-account' }
}

function codexAnswer(input: string): string[] {
  if (input.includes('"initialize"')) return ['{"id":1,"result":{}}\n']
  if (!input.includes('account/rateLimits/read')) return []
  return [
    `${JSON.stringify({
      id: 2,
      result: {
        rateLimits: {
          primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          credits: { hasCredits: true, balance: '5' },
          planType: 'plus'
        }
      }
    })}\n`
  ]
}

describe('oven account usage probe', () => {
  beforeEach(() => forgetOvenAccountUsage())

  it('reads Codex quota over the app-server handshake and forgets the run', async () => {
    const service = new FakeOvenService(codexAnswer)
    const telemetry = await readOvenAccountUsage(service as unknown as OvenService, codexTarget)

    expect(telemetry?.rateLimits.map((window) => window.usedPercent)).toEqual([42])
    expect(telemetry?.credits?.planType).toBe('plus')
    expect(service.starts[0]?.command).toBe('codex')
    expect(service.starts[0]?.environment).toEqual(codexTarget.environment)
    expect(service.removals).toHaveLength(1)
  })

  it('reuses one answer for the hovers that follow it', async () => {
    const service = new FakeOvenService(codexAnswer)
    await readOvenAccountUsage(service as unknown as OvenService, codexTarget)
    await readOvenAccountUsage(service as unknown as OvenService, codexTarget)
    expect(service.starts).toHaveLength(1)
  })

  it('reads Claude Code plan windows from its get_usage answer', async () => {
    const service = new FakeOvenService((input) =>
      input.includes('get_usage')
        ? [
            `${JSON.stringify({
              type: 'control_response',
              response: {
                request_id: 'usage',
                response: {
                  rate_limits_available: true,
                  rate_limits: {
                    five_hour: { utilization: 12, resets_at: '2026-01-01T00:00:00Z' }
                  }
                }
              }
            })}\n`
          ]
        : []
    )
    const telemetry = await readOvenAccountUsage(service as unknown as OvenService, {
      ...codexTarget,
      harnessId: 'claude-code',
      providerId: 'anthropic',
      accountId: 'claude-account',
      environment: { CLAUDE_CONFIG_DIR: codexTarget.cwd }
    })

    expect(service.starts[0]?.command).toBe('claude')
    expect(telemetry?.rateLimits[0]?.usedPercent).toBe(12)
  })

  it('reports nothing for a harness whose quota needs a resident local server', async () => {
    const service = new FakeOvenService(() => [])
    const telemetry = await readOvenAccountUsage(service as unknown as OvenService, {
      ...codexTarget,
      harnessId: 'opencode',
      accountId: 'opencode-account'
    })
    expect(telemetry).toBeNull()
    expect(service.starts).toHaveLength(0)
  })

  it('attaches the identity the reading belongs to', () => {
    expect(ovenAccountUsage(codexTarget, { rateLimits: [] })).toEqual({
      harnessId: 'codex',
      providerId: 'openai',
      accountId: 'codex-account',
      rateLimits: []
    })
  })
})
